// The forge's in-memory state: repositories, git objects, refs, issues, pull requests.
//
// Everything lives in memory: a trial is one process, and the suite's export is the suite's own
// (state.json/perf.json), so the forge needs no persistence. All ids are deterministic counters
// assigned in request order, so two runs of a trial produce identical bytes.

import { DEFAULT_BRANCH, VIEWER_LOGIN } from './constants.ts';
import type { CommitView, GitObject, TreeEntry } from './git.ts';
import { parseCommit, parseTree } from './git.ts';

export interface Label {
  readonly name: string;
  color: string;
}

export interface Comment {
  readonly id: number;
  body: string;
}

export interface Issue {
  readonly id: number; // global REST id (stable across reads)
  readonly number: number; // per-repo number, 1-based, increments
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  readonly comments: Comment[];
  /** Cached serialized REST JSON for GET /issues/{n} (invalidated on mutation). */
  jsonCache: string | null;
}

export interface Pull {
  readonly id: number; // global REST id
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly headRef: string;
  readonly baseRef: string;
  /** The head/base tips at creation time (refreshed on read from the live refs). */
  headSha: string;
  baseSha: string;
}

export interface Repo {
  readonly id: number; // databaseId, sequential from 1
  readonly name: string;
  readonly owner: string;
  description: string;
  private: boolean;
  readonly defaultBranch: string;
  /** refname -> oid (refs/heads/* and refs/tags/*). */
  readonly refs: Map<string, string>;
  /** oid -> object. */
  readonly objects: Map<string, GitObject>;
  readonly issues: Issue[];
  issueSeq: number;
  readonly labels: Map<string, Label>;
  readonly pulls: Pull[];
  pullSeq: number;
  /** Parsed-commit cache (keyed by oid). */
  readonly commitCache: Map<string, CommitView>;
  /** Parsed-tree cache (keyed by oid). */
  readonly treeCache: Map<string, TreeEntry[]>;
  /** Cached serialized REST JSON for GET /repos/{o}/{r} (invalidated on PATCH). */
  jsonCache: string | null;
  /** Cached serialized REST JSON for GET /branches (invalidated on ref change). */
  branchesCache: string | null;
}

/** The whole forge: one viewer, many repositories. */
export class Forge {
  /** `owner/name` -> repo. Owner is always VIEWER_LOGIN for created repos. */
  readonly repos = new Map<string, Repo>();
  /** Creation order, for GET /user/repos pagination. */
  readonly repoOrder: Repo[] = [];
  private nextRepoId = 1;
  private nextObjectId = 1; // global REST id counter (issues, pulls, comments)
  /** Sequential request counter for X-GitHub-Request-Id (deterministic, never empty). */
  requestSeq = 0;

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner: VIEWER_LOGIN,
      description,
      private: isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      refs: new Map(),
      objects: new Map(),
      issues: [],
      issueSeq: 0,
      labels: new Map(),
      pulls: [],
      pullSeq: 0,
      commitCache: new Map(),
      treeCache: new Map(),
      jsonCache: null,
      branchesCache: null,
    };
    this.repos.set(`${VIEWER_LOGIN}/${name}`, repo);
    this.repoOrder.push(repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | null {
    // A repository belongs to the login the token names; any other owner is a 404, never a 403.
    if (owner !== VIEWER_LOGIN) return null;
    return this.repos.get(`${owner}/${name}`) ?? null;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(`${repo.owner}/${repo.name}`);
    const index = this.repoOrder.indexOf(repo);
    if (index >= 0) this.repoOrder.splice(index, 1);
  }

  nextGlobalId(): number {
    return this.nextObjectId++;
  }

  nextRequestId(): string {
    this.requestSeq += 1;
    return `req-${this.requestSeq.toString(16).padStart(12, '0')}`;
  }
}

// ---------------------------------------------------------------------------------------------
// per-repo object helpers (with parse caches)
// ---------------------------------------------------------------------------------------------

export function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

export function putObject(repo: Repo, oid: string, object: GitObject): void {
  if (!repo.objects.has(oid)) repo.objects.set(oid, object);
}

export function getCommit(repo: Repo, oid: string): CommitView | null {
  const cached = repo.commitCache.get(oid);
  if (cached) return cached;
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'commit') return null;
  const parsed = parseCommit(object.data);
  repo.commitCache.set(oid, parsed);
  return parsed;
}

export function getTree(repo: Repo, oid: string): TreeEntry[] | null {
  const cached = repo.treeCache.get(oid);
  if (cached) return cached;
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tree') return null;
  const parsed = parseTree(object.data);
  repo.treeCache.set(oid, parsed);
  return parsed;
}

/** Resolve a ref name (branch, tag, full ref, or oid) to a commit oid, or null. */
export function resolveRef(repo: Repo, ref: string): string | null {
  // Direct oid.
  const direct = repo.objects.get(ref);
  if (direct && direct.type === 'commit') return ref;
  // Full ref.
  const full = repo.refs.get(ref);
  if (full !== undefined) return peelToCommit(repo, full);
  // Short branch name.
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch !== undefined) return peelToCommit(repo, branch);
  // Short tag name.
  const tag = repo.refs.get(`refs/tags/${ref}`);
  if (tag !== undefined) return peelToCommit(repo, tag);
  return null;
}

/** Peel a tag object to its commit target (recursively); a commit passes through. */
export function peelToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = repo.objects.get(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      const blank = object.data.indexOf('\n\n');
      const headers = object.data.subarray(0, blank < 0 ? object.data.length : blank).toString('utf8');
      const match = /^object ([0-9a-f]{40})$/m.exec(headers);
      if (!match) return null;
      current = match[1]!;
      continue;
    }
    return null;
  }
  return null;
}

/** The default branch's tip commit, or null for an unborn repo. */
export function defaultTip(repo: Repo): string | null {
  const ref = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (ref === undefined) return null;
  return peelToCommit(repo, ref);
}

// ---------------------------------------------------------------------------------------------
// opaque global (Relay) ids for GraphQL: base64 of a typed key, stable and never the plain id.
// ---------------------------------------------------------------------------------------------

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function unb64(text: string): string | null {
  try {
    const decoded = Buffer.from(text, 'base64').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64') !== text) return null;
    return decoded;
  } catch {
    return null;
  }
}

export function repoGlobalId(repo: Repo): string {
  return b64(`Repository:${repo.id}`);
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return b64(`Issue:${repo.id}:${issue.number}`);
}

export function pullGlobalId(repo: Repo, pull: Pull): string {
  return b64(`PullRequest:${repo.id}:${pull.number}`);
}

export function commentGlobalId(repo: Repo, issue: Issue, comment: Comment): string {
  return b64(`IssueComment:${repo.id}:${issue.number}:${comment.id}`);
}

/** Decode a global id into its kind and numeric parts, or null. */
export function decodeGlobalId(id: string): { kind: string; parts: number[] } | null {
  const decoded = unb64(id);
  if (decoded === null) return null;
  const [kind, ...rest] = decoded.split(':');
  if (kind === undefined || rest.length === 0) return null;
  const parts: number[] = [];
  for (const part of rest) {
    const n = Number(part);
    if (!Number.isInteger(n) || n <= 0) return null;
    parts.push(n);
  }
  return { kind, parts };
}

export function findRepoById(forge: Forge, id: number): Repo | null {
  for (const repo of forge.repoOrder) if (repo.id === id) return repo;
  return null;
}
