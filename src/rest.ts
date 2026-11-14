// GitHub REST v3 (api/v3): repositories, branches, commits, contents, labels, issues,
// comments and pull requests, over the same git object store the smart-HTTP surface uses.
//
// Every reply is application/json with a non-empty X-GitHub-Request-Id (added by the server);
// errors carry a JSON {message}. Auth is checked by the router before dispatch.

import { FIXED_ISO, VIEWER_ID, VIEWER_LOGIN } from './constants.ts';
import {
  buildTreeFromMap,
  commitList,
  createCommit,
  diffFlatTrees,
  flattenTree,
  isAncestor,
  lineDiffCounts,
  mergeBase,
  mergeFlatTrees,
  setBranch,
  treeListDir,
  treeLookup,
  updateTreePath,
  type FileChange,
} from './gitops.ts';
import { getCommit, getObject, getTree, resolveRef, type Forge, type Issue, type Label, type Pull, type Repo } from './store.ts';
import { hashObject, parseCommit } from './git.ts';

export interface RestContext {
  forge: Forge;
  method: string;
  /** Path segments after /api/v3, percent-decoded. */
  segments: string[];
  query: URLSearchParams;
  /** Parsed JSON body (null when no body was sent). */
  body: unknown;
  /** The request's Host header, for absolute Link URLs. */
  host: string;
}

export interface RestResult {
  status: number;
  /** Serialized JSON body (null for a 204). Cached bodies arrive pre-encoded as Buffers. */
  body: string | Buffer | null;
  headers?: Record<string, string>;
}

function ok(body: unknown, status = 200, headers?: Record<string, string>): RestResult {
  return { status, body: JSON.stringify(body), headers };
}

function err(status: number, message: string): RestResult {
  return { status, body: JSON.stringify({ message }) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

// ---------------------------------------------------------------------------------------------
// JSON shapes
// ---------------------------------------------------------------------------------------------

function userJson(): Record<string, unknown> {
  return { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(),
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color };
}

export function issueJson(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelJson),
    user: userJson(),
    comments: issue.comments.length,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  };
}

function commentJson(comment: { id: number; body: string }): Record<string, unknown> {
  return { id: comment.id, body: comment.body, user: userJson(), created_at: FIXED_ISO, updated_at: FIXED_ISO };
}

function branchTip(repo: Repo, branch: string): string | null {
  const ref = repo.refs.get(`refs/heads/${branch}`);
  if (ref === undefined) return null;
  return resolveRef(repo, ref) ?? ref;
}

export function pullJson(pull: Pull, repo: Repo): Record<string, unknown> {
  const headSha = branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseSha = branchTip(repo, pull.baseRef) ?? pull.baseSha;
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headSha },
    base: { ref: pull.baseRef, sha: baseSha },
    user: userJson(),
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  };
}

/** `Name <email> 1739175597 +0000` -> {name, email, date ISO}. */
function parseIdent(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
  if (!match) return { name: line, email: '', date: FIXED_ISO };
  const epoch = Number(match[3]);
  const date = Number.isFinite(epoch) ? new Date(epoch * 1000).toISOString() : FIXED_ISO;
  return { name: match[1] ?? '', email: match[2] ?? '', date };
}

function commitJson(repo: Repo, oid: string): Record<string, unknown> | null {
  const object = getObject(repo, oid);
  if (!object || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  const author = parseIdent(commit.author);
  const committer = parseIdent(commit.committer);
  return {
    sha: oid,
    commit: {
      message: commit.message,
      author,
      committer,
    },
    parents: commit.parents.map((sha) => ({ sha })),
  };
}

// ---------------------------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------------------------

function pageParams(query: URLSearchParams): { perPage: number; page: number } {
  const perPageRaw = Number(query.get('per_page'));
  const pageRaw = Number(query.get('page'));
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.floor(perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  return { perPage, page };
}

function paginate<T>(items: readonly T[], query: URLSearchParams, host: string, path: string): { page: T[]; link: string | null } {
  const { perPage, page } = pageParams(query);
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;
  const sliced = items.slice(start, start + perPage);
  const linkFor = (p: number): string => {
    const params = new URLSearchParams(query);
    params.set('page', String(p));
    params.set('per_page', String(perPage));
    return `<http://${host}${path}?${params.toString()}>`;
  };
  const links: string[] = [];
  if (page < totalPages) links.push(`${linkFor(page + 1)}; rel="next"`);
  if (page > 1) links.push(`${linkFor(page - 1)}; rel="prev"`);
  links.push(`${linkFor(1)}; rel="first"`);
  links.push(`${linkFor(totalPages)}; rel="last"`);
  return { page: sliced, link: links.join(', ') };
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

function repoFrom(ctx: RestContext, owner: string, name: string): Repo | null {
  return ctx.forge.getRepo(owner, name);
}

function issueNumber(segment: string): number | null {
  if (!/^\d+$/.test(segment)) return null;
  const n = Number(segment);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function findIssue(repo: Repo, number: number): Issue | null {
  return repo.issues.find((i) => i.number === number) ?? null;
}

function findPull(repo: Repo, number: number): Pull | null {
  return repo.pulls.find((p) => p.number === number) ?? null;
}

/** Strip an `owner:` prefix from a head/base ref (GitHub's cross-fork spelling). */
function stripOwnerPrefix(ref: string): string {
  const colon = ref.indexOf(':');
  return colon >= 0 ? ref.slice(colon + 1) : ref;
}

// ---------------------------------------------------------------------------------------------
// the router
// ---------------------------------------------------------------------------------------------

export function handleRest(ctx: RestContext): RestResult {
  const [first, ...rest] = ctx.segments;
  const { method } = ctx;

  // GET /api/v3/ and /api/v3/meta
  if (ctx.segments.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(
      {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        message: 'github-forge',
      },
      200,
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }
  if (first === 'meta' && ctx.segments.length === 1) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok({ installed_version: '1.0.0' });
  }
  if (first === 'user' && ctx.segments.length === 1) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok({ login: VIEWER_LOGIN, id: VIEWER_ID, name: 'ada iversen', email: 'adaiversen@example.invalid', type: 'User' });
  }
  if (first === 'user' && rest[0] === 'repos' && ctx.segments.length === 2) {
    if (method === 'POST') return createRepo(ctx);
    if (method === 'GET') return listUserRepos(ctx);
    return err(404, 'Not Found');
  }
  if (first === 'repos' && rest.length >= 2) {
    return handleRepoRoute(ctx, rest[0]!, rest[1]!, rest.slice(2));
  }
  return err(404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// /user/repos
// ---------------------------------------------------------------------------------------------

function createRepo(ctx: RestContext): RestResult {
  const body = ctx.body;
  if (!isRecord(body)) return err(422, 'Validation Failed: name is required');
  const name = asString(body.name);
  if (name === null || name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
    return err(422, 'Validation Failed: name is invalid');
  }
  if (ctx.forge.getRepo(VIEWER_LOGIN, name) !== null) {
    return err(422, `Repository ${VIEWER_LOGIN}/${name} already exists`);
  }
  const description = asString(body.description) ?? '';
  const isPrivate = body.private === true;
  const repo = ctx.forge.createRepo(name, description, isPrivate);
  return ok(repoJson(repo), 201);
}

function listUserRepos(ctx: RestContext): RestResult {
  const repos = ctx.forge.repoOrder;
  const { page, link } = paginate(repos, ctx.query, ctx.host, '/api/v3/user/repos');
  return ok(
    page.map(repoJson),
    200,
    link === null ? undefined : { link },
  );
}

// ---------------------------------------------------------------------------------------------
// /repos/{owner}/{name}/...
// ---------------------------------------------------------------------------------------------

function handleRepoRoute(ctx: RestContext, owner: string, name: string, tail: string[]): RestResult {
  const repo = repoFrom(ctx, owner, name);
  if (!repo) return err(404, `Repository ${owner}/${name} not found`);
  const { method } = ctx;

  if (tail.length === 0) {
    if (method === 'GET') {
      if (repo.jsonCache === null) repo.jsonCache = Buffer.from(JSON.stringify(repoJson(repo)), 'utf8');
      return { status: 200, body: repo.jsonCache };
    }
    if (method === 'PATCH') {
      const body = ctx.body;
      if (!isRecord(body)) return err(422, 'Validation Failed');
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      repo.jsonCache = null;
      return ok(repoJson(repo));
    }
    if (method === 'DELETE') {
      ctx.forge.deleteRepo(repo);
      return { status: 204, body: null };
    }
    return err(404, 'Not Found');
  }

  const [section, ...sub] = tail;
  switch (section) {
    case 'branches':
      if (method === 'GET' && sub.length === 0) return listBranches(repo);
      if (method === 'GET' && sub.length >= 1) return getBranch(repo, sub.join('/'));
      return err(404, 'Not Found');
    case 'commits':
      if (method === 'GET' && sub.length === 0) return listCommits(ctx, repo);
      return err(404, 'Not Found');
    case 'git':
      if (sub[0] === 'refs' && method === 'POST' && sub.length === 1) return createRef(ctx, repo);
      if (sub[0] === 'refs' && method === 'GET' && sub.length >= 2) return getRef(repo, sub.slice(1).join('/'));
      return err(404, 'Not Found');
    case 'contents':
      return handleContents(ctx, repo, sub.join('/'));
    case 'labels':
      if (method === 'POST' && sub.length === 0) return createLabel(ctx, repo);
      if (method === 'GET' && sub.length === 0) return ok([...repo.labels.values()].map(labelJson));
      return err(404, 'Not Found');
    case 'issues':
      return handleIssues(ctx, repo, sub);
    case 'pulls':
      return handlePulls(ctx, repo, sub);
    default:
      return err(404, 'Not Found');
  }
}

// ---------------------------------------------------------------------------------------------
// branches, commits, refs
// ---------------------------------------------------------------------------------------------

function listBranches(repo: Repo): RestResult {
  if (repo.branchesCache === null) {
    const branches = [...repo.refs.keys()]
      .filter((r) => r.startsWith('refs/heads/'))
      .sort()
      .map((ref) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref)! } }));
    repo.branchesCache = Buffer.from(JSON.stringify(branches), 'utf8');
  }
  return { status: 200, body: repo.branchesCache };
}

function getBranch(repo: Repo, branch: string): RestResult {
  const oid = repo.refs.get(`refs/heads/${branch}`);
  if (oid === undefined) return err(404, `Branch ${branch} not found`);
  return ok({ name: branch, commit: { sha: oid }, protected: false });
}

function listCommits(ctx: RestContext, repo: Repo): RestResult {
  const ref = ctx.query.get('sha') ?? repo.defaultBranch;
  const tip = resolveRef(repo, ref);
  if (tip === null) return err(404, `Reference ${ref} not found`);
  const { perPage } = pageParams(ctx.query);
  const limit = ctx.query.has('per_page') ? perPage : 1000;
  const oids = commitList(repo, tip, limit);
  const out: Record<string, unknown>[] = [];
  for (const oid of oids) {
    const json = commitJson(repo, oid);
    if (json) out.push(json);
  }
  return ok(out);
}

function createRef(ctx: RestContext, repo: Repo): RestResult {
  const body = ctx.body;
  if (!isRecord(body)) return err(422, 'Validation Failed');
  const ref = asString(body.ref);
  const sha = asString(body.sha);
  if (ref === null || !ref.startsWith('refs/') || sha === null) return err(422, 'Validation Failed: ref and sha are required');
  if (repo.refs.has(ref)) return err(422, 'Reference already exists');
  const object = getObject(repo, sha);
  if (!object) return err(422, `Object ${sha} does not exist`);
  if (ref.startsWith('refs/heads/')) {
    const commit = resolveRef(repo, sha);
    if (commit === null) return err(422, `Object ${sha} is not a commit`);
  }
  repo.refs.set(ref, sha);
  repo.branchesCache = null;
  repo.refsVersion += 1;
  return ok({ ref, object: { sha, type: object.type } }, 201);
}

function getRef(repo: Repo, refPath: string): RestResult {
  const ref = `refs/${refPath}`;
  const oid = repo.refs.get(ref);
  if (oid === undefined) return err(404, `Reference ${ref} not found`);
  const object = getObject(repo, oid);
  return ok({ ref, object: { sha: oid, type: object?.type ?? 'commit' } });
}

// ---------------------------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------------------------

function handleContents(ctx: RestContext, repo: Repo, path: string): RestResult {
  const { method } = ctx;
  if (method === 'GET') return getContents(ctx, repo, path);
  if (method === 'PUT') return putContents(ctx, repo, path);
  if (method === 'DELETE') return deleteContents(ctx, repo, path);
  return err(404, 'Not Found');
}

function contentsRefTip(ctx: RestContext, repo: Repo, branch?: string): string | null {
  const ref = branch ?? ctx.query.get('ref') ?? repo.defaultBranch;
  return resolveRef(repo, ref);
}

function getContents(ctx: RestContext, repo: Repo, path: string): RestResult {
  const tip = contentsRefTip(ctx, repo);
  if (tip === null) return err(404, 'Not Found');
  const commit = getCommit(repo, tip);
  if (!commit) return err(404, 'Not Found');
  if (path === '') {
    const entries = treeListDir(repo, commit.tree, '');
    if (!entries) return err(404, 'Not Found');
    return ok(
      entries.map((e) => ({
        type: e.isDir ? 'dir' : 'file',
        name: e.name,
        path: e.name,
        sha: e.oid,
        size: e.isDir ? 0 : (getObject(repo, e.oid)?.data.length ?? 0),
      })),
    );
  }
  const entry = treeLookup(repo, commit.tree, path);
  if (entry !== null && entry.mode !== '40000') {
    const blob = getObject(repo, entry.oid);
    if (!blob || blob.type !== 'blob') return err(404, 'Not Found');
    const name = path.split('/').pop() ?? path;
    return ok({
      type: 'file',
      encoding: 'base64',
      content: blob.data.toString('base64'),
      sha: entry.oid,
      size: blob.data.length,
      name,
      path,
    });
  }
  const dir = treeListDir(repo, commit.tree, path);
  if (dir !== null) {
    return ok(
      dir.map((e) => ({
        type: e.isDir ? 'dir' : 'file',
        name: e.name,
        path: `${path}/${e.name}`,
        sha: e.oid,
        size: e.isDir ? 0 : (getObject(repo, e.oid)?.data.length ?? 0),
      })),
    );
  }
  return err(404, 'Not Found');
}

function putContents(ctx: RestContext, repo: Repo, path: string): RestResult {
  if (path === '') return err(422, 'Validation Failed: path is required');
  const body = ctx.body;
  if (!isRecord(body)) return err(422, 'Validation Failed');
  const contentB64 = asString(body.content);
  if (contentB64 === null) return err(422, 'Validation Failed: content is required');
  const message = asString(body.message) ?? `Update ${path}`;
  const branch = asString(body.branch) ?? repo.defaultBranch;
  const givenSha = asString(body.sha);

  // The branch to write on: an unknown branch starts from the default branch's tip.
  let parent: string | null = null;
  let baseTree: string | null = null;
  const existingRef = repo.refs.get(`refs/heads/${branch}`);
  if (existingRef !== undefined) {
    parent = resolveRef(repo, existingRef);
    const commit = parent ? getCommit(repo, parent) : null;
    baseTree = commit?.tree ?? null;
  } else if (branch !== repo.defaultBranch) {
    const defaultTip = resolveRef(repo, repo.defaultBranch);
    if (defaultTip !== null) {
      parent = defaultTip;
      baseTree = getCommit(repo, defaultTip)?.tree ?? null;
    }
  }
  if (parent === null && repo.refs.size > 0 && existingRef === undefined && branch === repo.defaultBranch) {
    // The default branch is unborn but other refs exist: start from nothing.
    parent = null;
    baseTree = null;
  }

  const current = treeLookup(repo, baseTree, path);
  const isUpdate = current !== null && current.mode !== '40000';
  if (givenSha !== null) {
    if (!isUpdate) return err(422, `File ${path} does not exist`);
    if (givenSha !== current!.oid) return err(409, `sha ${givenSha} does not match the current blob ${current!.oid}`);
  } else if (isUpdate) {
    return err(422, `File ${path} already exists`);
  }

  const data = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
  const blobOid = hashObject('blob', data);
  if (!repo.objects.has(blobOid)) repo.objects.set(blobOid, { type: 'blob', data });
  const newTree = updateTreePath(repo, baseTree, path, blobOid);
  const commitOid = createCommit(repo, newTree, parent === null ? [] : [parent], message);
  setBranch(repo, branch, commitOid);
  const name = path.split('/').pop() ?? path;
  return ok(
    {
      content: { name, path, sha: blobOid, size: data.length, type: 'file', encoding: 'base64', content: contentB64 },
      commit: { sha: commitOid, message },
    },
    isUpdate ? 200 : 201,
  );
}

function deleteContents(ctx: RestContext, repo: Repo, path: string): RestResult {
  if (path === '') return err(422, 'Validation Failed: path is required');
  const body = ctx.body;
  if (!isRecord(body)) return err(422, 'Validation Failed');
  const message = asString(body.message) ?? `Delete ${path}`;
  const branch = asString(body.branch) ?? repo.defaultBranch;
  const givenSha = asString(body.sha);
  if (givenSha === null) return err(422, 'Validation Failed: sha is required');
  const tip = resolveRef(repo, branch);
  if (tip === null) return err(404, 'Not Found');
  const commit = getCommit(repo, tip);
  if (!commit) return err(404, 'Not Found');
  const current = treeLookup(repo, commit.tree, path);
  if (current === null || current.mode === '40000') return err(404, 'Not Found');
  if (givenSha !== current.oid) return err(409, `sha ${givenSha} does not match the current blob ${current.oid}`);
  const newTree = updateTreePath(repo, commit.tree, path, null);
  const commitOid = createCommit(repo, newTree, [tip], message);
  setBranch(repo, branch, commitOid);
  return ok({ content: null, commit: { sha: commitOid, message } });
}

// ---------------------------------------------------------------------------------------------
// labels
// ---------------------------------------------------------------------------------------------

function createLabel(ctx: RestContext, repo: Repo): RestResult {
  const body = ctx.body;
  if (!isRecord(body)) return err(422, 'Validation Failed');
  const name = asString(body.name);
  if (name === null || name === '') return err(422, 'Validation Failed: name is required');
  if (repo.labels.has(name)) return err(422, `Label ${name} already exists`);
  const color = asString(body.color) ?? 'ededed';
  const label: Label = { name, color };
  repo.labels.set(name, label);
  return ok(labelJson(label), 201);
}

// ---------------------------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------------------------

function handleIssues(ctx: RestContext, repo: Repo, sub: string[]): RestResult {
  const { method } = ctx;
  if (sub.length === 0) {
    if (method === 'POST') return createIssue(ctx, repo);
    if (method === 'GET') return listIssues(ctx, repo);
    return err(404, 'Not Found');
  }
  const number = issueNumber(sub[0]!);
  if (number === null) return err(404, 'Not Found');
  const issue = findIssue(repo, number);
  if (!issue) return err(404, `Issue #${number} not found`);
  if (sub.length === 1) {
    if (method === 'GET') {
      if (issue.jsonCache === null) issue.jsonCache = Buffer.from(JSON.stringify(issueJson(issue)), 'utf8');
      return { status: 200, body: issue.jsonCache };
    }
    if (method === 'PATCH') return patchIssue(ctx, repo, issue);
    return err(404, 'Not Found');
  }
  if (sub[1] === 'comments' && sub.length === 2) {
    if (method === 'POST') return createComment(ctx, repo, issue);
    if (method === 'GET') return ok(issue.comments.map(commentJson));
    return err(404, 'Not Found');
  }
  return err(404, 'Not Found');
}

function resolveLabels(repo: Repo, value: unknown): { labels: Label[]; error: string | null } {
  if (value === undefined) return { labels: [], error: null };
  if (!Array.isArray(value)) return { labels: [], error: 'labels must be an array' };
  const labels: Label[] = [];
  for (const entry of value) {
    const name = typeof entry === 'string' ? entry : isRecord(entry) ? asString(entry.name) : null;
    if (name === null) return { labels: [], error: 'labels must be names' };
    const label = repo.labels.get(name);
    if (!label) return { labels: [], error: `Label ${name} does not exist` };
    labels.push(label);
  }
  return { labels, error: null };
}

function createIssue(ctx: RestContext, repo: Repo): RestResult {
  const body = ctx.body;
  if (!isRecord(body)) return err(422, 'Validation Failed');
  const title = asString(body.title);
  if (title === null || title === '') return err(422, 'Validation Failed: title is required');
  const { labels, error } = resolveLabels(repo, body.labels);
  if (error !== null) return err(422, error);
  const issue: Issue = {
    id: ctx.forge.nextGlobalId(),
    number: ++repo.issueSeq,
    title,
    body: asString(body.body) ?? '',
    state: 'open',
    labels,
    comments: [],
    jsonCache: null,
  };
  repo.issues.push(issue);
  return ok(issueJson(issue), 201);
}

function listIssues(ctx: RestContext, repo: Repo): RestResult {
  const state = ctx.query.get('state') ?? 'open';
  const direction = ctx.query.get('direction') ?? 'desc';
  let issues = repo.issues;
  if (state === 'open') issues = issues.filter((i) => i.state === 'open');
  else if (state === 'closed') issues = issues.filter((i) => i.state === 'closed');
  else if (state !== 'all') issues = issues.filter((i) => i.state === 'open');
  const ordered = direction === 'asc' ? [...issues] : [...issues].reverse();
  const { page, link } = paginate(ordered, ctx.query, ctx.host, `/api/v3/repos/${repo.owner}/${repo.name}/issues`);
  return ok(
    page.map(issueJson),
    200,
    link === null ? undefined : { link },
  );
}

function patchIssue(ctx: RestContext, repo: Repo, issue: Issue): RestResult {
  const body = ctx.body;
  if (!isRecord(body)) return err(422, 'Validation Failed');
  if (typeof body.state === 'string') {
    if (body.state !== 'open' && body.state !== 'closed') return err(422, 'Validation Failed: state must be open or closed');
    issue.state = body.state;
  }
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
  if (body.labels !== undefined) {
    const { labels, error } = resolveLabels(repo, body.labels);
    if (error !== null) return err(422, error);
    issue.labels = labels;
  }
  issue.jsonCache = null;
  return ok(issueJson(issue));
}

function createComment(ctx: RestContext, repo: Repo, issue: Issue): RestResult {
  const body = ctx.body;
  if (!isRecord(body)) return err(422, 'Validation Failed');
  const text = asString(body.body);
  if (text === null || text === '') return err(422, 'Validation Failed: body is required');
  const comment = { id: ctx.forge.nextGlobalId(), body: text };
  issue.comments.push(comment);
  issue.jsonCache = null;
  return ok(commentJson(comment), 201);
}

// ---------------------------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------------------------

function handlePulls(ctx: RestContext, repo: Repo, sub: string[]): RestResult {
  const { method } = ctx;
  if (sub.length === 0) {
    if (method === 'POST') return createPull(ctx, repo);
    if (method === 'GET') return listPulls(ctx, repo);
    return err(404, 'Not Found');
  }
  const number = issueNumber(sub[0]!);
  if (number === null) return err(404, 'Not Found');
  const pull = findPull(repo, number);
  if (!pull) return err(404, `Pull request #${number} not found`);
  if (sub.length === 1) {
    if (method === 'GET') return ok(pullJson(pull, repo));
    return err(404, 'Not Found');
  }
  if (sub[1] === 'files' && sub.length === 2 && method === 'GET') return listPullFiles(repo, pull);
  if (sub[1] === 'merge' && sub.length === 2 && method === 'PUT') return mergePull(ctx, repo, pull);
  return err(404, 'Not Found');
}

function createPull(ctx: RestContext, repo: Repo): RestResult {
  const body = ctx.body;
  if (!isRecord(body)) return err(422, 'Validation Failed');
  const title = asString(body.title);
  const headRaw = asString(body.head);
  const baseRaw = asString(body.base);
  if (title === null || title === '') return err(422, 'Validation Failed: title is required');
  if (headRaw === null || baseRaw === null) return err(422, 'Validation Failed: head and base are required');
  const head = stripOwnerPrefix(headRaw);
  const base = stripOwnerPrefix(baseRaw);
  const headTip = branchTip(repo, head);
  const baseTip = branchTip(repo, base);
  if (headTip === null) return err(422, `Head branch ${head} does not exist`);
  if (baseTip === null) return err(422, `Base branch ${base} does not exist`);
  if (head === base) return err(422, 'No commits between the head and base branches');
  if (headTip === baseTip) return err(422, `No commits between ${base} and ${head}`);
  const duplicate = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
  if (duplicate) return err(422, `A pull request already exists for ${head} into ${base}`);
  const pull: Pull = {
    id: ctx.forge.nextGlobalId(),
    number: ++repo.pullSeq,
    title,
    body: asString(body.body) ?? '',
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: head,
    baseRef: base,
    headSha: headTip,
    baseSha: baseTip,
  };
  repo.pulls.push(pull);
  return ok(pullJson(pull, repo), 201);
}

function listPulls(ctx: RestContext, repo: Repo): RestResult {
  const state = ctx.query.get('state') ?? 'open';
  let pulls = repo.pulls;
  if (state === 'open') pulls = pulls.filter((p) => p.state === 'open');
  else if (state === 'closed') pulls = pulls.filter((p) => p.state === 'closed');
  else if (state !== 'all') pulls = pulls.filter((p) => p.state === 'open');
  const ordered = [...pulls].reverse();
  const { page, link } = paginate(ordered, ctx.query, ctx.host, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`);
  return ok(
    page.map((p) => pullJson(p, repo)),
    200,
    link === null ? undefined : { link },
  );
}

/** The merge-base and the head/base tips for a pull request, or null when a branch is gone. */
function pullTips(repo: Repo, pull: Pull): { headTip: string; baseTip: string; mergeBaseOid: string } | null {
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return null;
  const base = mergeBase(repo, baseTip, headTip) ?? baseTip;
  return { headTip, baseTip, mergeBaseOid: base };
}

/** The file-level diff of a pull request (merge-base...head), with line counts. */
export function pullFileDiff(
  repo: Repo,
  pull: Pull,
): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
  const tips = pullTips(repo, pull);
  if (!tips) return [];
  const baseCommit = getCommit(repo, tips.mergeBaseOid);
  const headCommit = getCommit(repo, tips.headTip);
  if (!baseCommit || !headCommit) return [];
  const baseFiles = flattenTree(repo, baseCommit.tree);
  const headFiles = flattenTree(repo, headCommit.tree);
  const changes: FileChange[] = diffFlatTrees(baseFiles, headFiles);
  const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
  for (const change of changes) {
    const oldText = change.oldOid ? (getObject(repo, change.oldOid)?.data.toString('utf8') ?? '') : '';
    const newText = change.newOid ? (getObject(repo, change.newOid)?.data.toString('utf8') ?? '') : '';
    const counts = lineDiffCounts(oldText, newText);
    out.push({
      filename: change.path,
      status: change.status,
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
    });
  }
  return out;
}

function listPullFiles(repo: Repo, pull: Pull): RestResult {
  return ok(pullFileDiff(repo, pull));
}

/** Whether a pull request merges cleanly (the GraphQL `mergeable` field uses this too). */
export function pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open') return 'UNKNOWN';
  const tips = pullTips(repo, pull);
  if (!tips) return 'UNKNOWN';
  const baseCommit = getCommit(repo, tips.mergeBaseOid);
  const headCommit = getCommit(repo, tips.headTip);
  const oursCommit = getCommit(repo, tips.baseTip);
  if (!baseCommit || !headCommit || !oursCommit) return 'UNKNOWN';
  const merged = mergeFlatTrees(
    repo,
    flattenTree(repo, baseCommit.tree),
    flattenTree(repo, oursCommit.tree),
    flattenTree(repo, headCommit.tree),
  );
  return merged.conflict ? 'CONFLICTING' : 'MERGEABLE';
}

function mergePull(ctx: RestContext, repo: Repo, pull: Pull): RestResult {
  const body = isRecord(ctx.body) ? ctx.body : {};
  const method = asString(body.merge_method) ?? 'merge';
  if (pull.state !== 'open') return err(405, 'Pull Request is not mergeable: it is already closed');
  if (method !== 'squash' && method !== 'merge') return err(405, `Merge method ${method} is not supported`);
  const tips = pullTips(repo, pull);
  if (!tips) return err(405, 'Pull Request is not mergeable: a branch is missing');
  if (isAncestor(repo, tips.headTip, tips.baseTip)) {
    return err(405, 'Pull Request is not mergeable: the head is already merged');
  }
  const baseCommit = getCommit(repo, tips.mergeBaseOid);
  const headCommit = getCommit(repo, tips.headTip);
  const oursCommit = getCommit(repo, tips.baseTip);
  if (!baseCommit || !headCommit || !oursCommit) return err(405, 'Pull Request is not mergeable');
  const merged = mergeFlatTrees(
    repo,
    flattenTree(repo, baseCommit.tree),
    flattenTree(repo, oursCommit.tree),
    flattenTree(repo, headCommit.tree),
  );
  if (merged.conflict) return err(405, 'Merge conflict: the pull request cannot be merged cleanly');
  const treeOid = buildTreeFromMap(repo, merged.merged);
  const parents = method === 'squash' ? [tips.baseTip] : [tips.baseTip, tips.headTip];
  const message =
    method === 'squash' ? `${pull.title} (#${pull.number})` : `Merge pull request #${pull.number} from ${pull.headRef}`;
  const commitOid = createCommit(repo, treeOid, parents, message);
  setBranch(repo, pull.baseRef, commitOid);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = FIXED_ISO;
  pull.mergeCommitSha = commitOid;
  pull.baseSha = commitOid;
  return ok({ merged: true, sha: commitOid, message: 'Pull Request successfully merged' });
}
