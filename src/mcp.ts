// Model Context Protocol (POST /mcp), streamable HTTP, legacy handshake era (2025-11-25).
//
// The suite probes `server/discover` first; this server answers method-not-found (-32601),
// which the client treats as the pre-discover era and falls back to `initialize` +
// `notifications/initialized`. Tools are the six github-mcp-server names; every tool result
// carries both a text block (JSON) and structuredContent, and every tool mutates the same
// in-memory state the REST surface reads.

import { FIXED_ISO } from './constants.ts';
import {
  buildTreeFromMap,
  createCommit,
  flattenTree,
  isAncestor,
  mergeBase,
  mergeFlatTrees,
  setBranch,
} from './gitops.ts';
import { getCommit } from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';
import type { Forge, Issue, Pull, Repo } from './store.ts';

export interface McpResult {
  status: number;
  /** Serialized JSON body (null for a 202 with no body). */
  body: string | null;
}

const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;

const SERVER_NAME = 'github-forge';
const SERVER_VERSION = '1.0.0';
const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

// ---------------------------------------------------------------------------------------------
// tool definitions (static: tools/list is byte-identical across calls)
// ---------------------------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

// ---------------------------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rpcResult(id: unknown, result: unknown): McpResult {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id, result }) };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpResult {
  return { status, body: JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) };
}

function toolOk(value: unknown): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function handleMcp(forge: Forge, bodyText: string): McpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return rpcError(null, JSON_RPC_PARSE_ERROR, 'Parse error', 400);
  }
  if (!isRecord(parsed)) return rpcError(null, JSON_RPC_INVALID_REQUEST, 'Invalid Request');
  const id = 'id' in parsed ? parsed.id : undefined;
  const isNotification = id === undefined;
  const method = typeof parsed.method === 'string' ? parsed.method : '';
  const params = isRecord(parsed.params) ? parsed.params : {};

  if (method === 'server/discover') {
    // Pre-discover era: the client falls back to the initialize handshake.
    return rpcError(id ?? null, JSON_RPC_METHOD_NOT_FOUND, 'Method not found: server/discover');
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = LEGACY_REVISIONS.includes(requested) ? requested : '2025-11-25';
    return rpcResult(id ?? null, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'notifications/initialized') {
    return { status: 202, body: null };
  }
  if (isNotification) {
    // Any other notification: acknowledge silently.
    return { status: 202, body: null };
  }
  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? params.arguments : {};
    return callTool(forge, id, name, args);
  }
  return rpcError(id ?? null, JSON_RPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
}

// ---------------------------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------------------------

function requiredString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function callTool(forge: Forge, id: unknown, name: string, args: Record<string, unknown>): McpResult {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    return rpcError(id, JSON_RPC_INVALID_PARAMS, `Unknown tool: ${name}`);
  }
  // Required-argument validation (the missing-arguments check calls create_issue with {}).
  const required = (tool.inputSchema.required as string[]) ?? [];
  for (const key of required) {
    const value = args[key];
    if (value === undefined || value === null || value === '') {
      return rpcError(id, JSON_RPC_INVALID_PARAMS, `Missing required argument: ${key}`);
    }
  }
  try {
    switch (name) {
      case 'create_repo':
        return rpcResult(id, toolCreateRepo(forge, args));
      case 'get_repo':
        return rpcResult(id, toolGetRepo(forge, args));
      case 'create_issue':
        return rpcResult(id, toolCreateIssue(forge, args));
      case 'list_issues':
        return rpcResult(id, toolListIssues(forge, args));
      case 'create_pull_request':
        return rpcResult(id, toolCreatePullRequest(forge, args));
      case 'merge_pull_request':
        return rpcResult(id, toolMergePullRequest(forge, args));
      default:
        return rpcError(id, JSON_RPC_INVALID_PARAMS, `Unknown tool: ${name}`);
    }
  } catch (err) {
    return rpcResult(id, toolError(err instanceof Error ? err.message : String(err)));
  }
}

function lookupRepo(forge: Forge, args: Record<string, unknown>): Repo | null {
  const owner = requiredString(args, 'owner');
  const repo = requiredString(args, 'repo');
  if (owner === null || repo === null) return null;
  return forge.getRepo(owner, repo);
}

function toolCreateRepo(forge: Forge, args: Record<string, unknown>): Record<string, unknown> {
  const name = requiredString(args, 'name');
  if (name === null) return toolError('Missing required argument: name');
  if (forge.getRepo('adaiversen', name) !== null) return toolError(`Repository adaiversen/${name} already exists`);
  const description = typeof args.description === 'string' ? args.description : '';
  const isPrivate = args.private === true;
  const repo = forge.createRepo(name, description, isPrivate);
  return toolOk(repoJson(repo));
}

function toolGetRepo(forge: Forge, args: Record<string, unknown>): Record<string, unknown> {
  const repo = lookupRepo(forge, args);
  if (!repo) return toolError(`Repository ${String(args.owner)}/${String(args.repo)} not found`);
  return toolOk(repoJson(repo));
}

function toolCreateIssue(forge: Forge, args: Record<string, unknown>): Record<string, unknown> {
  const repo = lookupRepo(forge, args);
  if (!repo) return toolError(`Repository ${String(args.owner)}/${String(args.repo)} not found`);
  const title = requiredString(args, 'title');
  if (title === null) return toolError('Missing required argument: title');
  const issue: Issue = {
    id: forge.nextGlobalId(),
    number: ++repo.issueSeq,
    title,
    body: typeof args.body === 'string' ? args.body : '',
    state: 'open',
    labels: [],
    comments: [],
    jsonCache: null,
  };
  repo.issues.push(issue);
  return toolOk(issueJson(issue));
}

function toolListIssues(forge: Forge, args: Record<string, unknown>): Record<string, unknown> {
  const repo = lookupRepo(forge, args);
  if (!repo) return toolError(`Repository ${String(args.owner)}/${String(args.repo)} not found`);
  const state = typeof args.state === 'string' ? args.state : 'open';
  let issues = repo.issues;
  if (state === 'open') issues = issues.filter((i) => i.state === 'open');
  else if (state === 'closed') issues = issues.filter((i) => i.state === 'closed');
  const list = issues.map(issueJson);
  return { content: [{ type: 'text', text: JSON.stringify(list) }], structuredContent: { issues: list } };
}

function toolCreatePullRequest(forge: Forge, args: Record<string, unknown>): Record<string, unknown> {
  const repo = lookupRepo(forge, args);
  if (!repo) return toolError(`Repository ${String(args.owner)}/${String(args.repo)} not found`);
  const title = requiredString(args, 'title');
  const head = requiredString(args, 'head');
  const base = requiredString(args, 'base');
  if (title === null || head === null || base === null) return toolError('Missing required argument: title, head or base');
  const headTip = repo.refs.get(`refs/heads/${head}`);
  const baseTip = repo.refs.get(`refs/heads/${base}`);
  if (!headTip) return toolError(`Head branch ${head} does not exist`);
  if (!baseTip) return toolError(`Base branch ${base} does not exist`);
  if (headTip === baseTip) return toolError(`No commits between ${base} and ${head}`);
  const duplicate = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
  if (duplicate) return toolError(`A pull request already exists for ${head} into ${base}`);
  const pull: Pull = {
    id: forge.nextGlobalId(),
    number: ++repo.pullSeq,
    title,
    body: typeof args.body === 'string' ? args.body : '',
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
  return toolOk(pullJson(pull, repo));
}

function toolMergePullRequest(forge: Forge, args: Record<string, unknown>): Record<string, unknown> {
  const repo = lookupRepo(forge, args);
  if (!repo) return toolError(`Repository ${String(args.owner)}/${String(args.repo)} not found`);
  const rawNumber = args.pull_number;
  const number = typeof rawNumber === 'number' ? rawNumber : typeof rawNumber === 'string' ? Number(rawNumber) : NaN;
  if (!Number.isInteger(number) || number <= 0) return toolError('Missing required argument: pull_number');
  const pull = repo.pulls.find((p) => p.number === number);
  if (!pull) return toolError(`Pull request #${number} not found`);
  if (pull.state !== 'open') return toolError(`Pull request #${number} is already closed`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (!headTip || !baseTip) return toolError('A branch is missing');
  if (isAncestor(repo, headTip, baseTip)) return toolError('The head is already merged');
  const baseOid = mergeBase(repo, baseTip, headTip) ?? baseTip;
  const baseCommit = getCommit(repo, baseOid);
  const headCommit = getCommit(repo, headTip);
  const oursCommit = getCommit(repo, baseTip);
  if (!baseCommit || !headCommit || !oursCommit) return toolError('A commit is missing');
  const merged = mergeFlatTrees(
    repo,
    flattenTree(repo, baseCommit.tree),
    flattenTree(repo, oursCommit.tree),
    flattenTree(repo, headCommit.tree),
  );
  if (merged.conflict) return toolError('Merge conflict: the pull request cannot be merged cleanly');
  const treeOid = buildTreeFromMap(repo, merged.merged);
  const commitOid = createCommit(repo, treeOid, [baseTip], `${pull.title} (#${pull.number})`);
  setBranch(repo, pull.baseRef, commitOid);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = FIXED_ISO;
  pull.mergeCommitSha = commitOid;
  pull.baseSha = commitOid;
  return toolOk(pullJson(pull, repo));
}
