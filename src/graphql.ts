// GraphQL v4 (POST /api/graphql): the exact documents gh and github-mcp-server send.
//
// A hand-rolled parser + executor for those shapes only (no generic GraphQL engine):
// queries and mutations with variables, aliases, inline enum lists and input objects, inline
// fragments (`... on Repository`), `__type` introspection, and JSON-array operation batching.
// An unknown field is a 200 with an `errors` array naming it, never an HTTP error.

import { VIEWER_LOGIN } from './constants.ts';
import { pullFileDiff, pullMergeable } from './rest.ts';
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
import {
  decodeGlobalId,
  findRepoById,
  issueGlobalId,
  pullGlobalId,
  repoGlobalId,
  commentGlobalId,
  type Forge,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import { FIXED_ISO } from './constants.ts';

// ---------------------------------------------------------------------------------------------
// schema tables (field lists drive validation AND __type introspection)
// ---------------------------------------------------------------------------------------------

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private',
  ],
  Ref: ['name', 'target'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'labels', 'author', 'createdAt', 'updatedAt'],
  IssueConnection: ['nodes', 'pageInfo', 'edges', 'totalCount'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  PullRequest: [
    'id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable',
    'files', 'body', 'author',
  ],
  PullRequestConnection: ['nodes', 'pageInfo', 'edges', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  IssueComment: ['id', 'body', 'author'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ---------------------------------------------------------------------------------------------
// tokenizer + parser
// ---------------------------------------------------------------------------------------------

interface Token {
  kind: 'name' | 'int' | 'string' | 'punct' | 'eof';
  value: string;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < input.length) {
    const c = input[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let value = '';
      i += 1;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) {
          const esc = input[i + 1]!;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          i += 2;
        } else {
          value += input[i];
          i += 1;
        }
      }
      i += 1; // closing quote
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (c === '-' || /[0-9]/.test(c)) {
      let value = '';
      while (i < input.length && /[0-9.]/.test(input[i]!)) {
        value += input[i];
        i += 1;
      }
      tokens.push({ kind: 'int', value });
      continue;
    }
    if (isNameStart(c)) {
      let value = '';
      while (i < input.length && isNameChar(input[i]!)) {
        value += input[i];
        i += 1;
      }
      tokens.push({ kind: 'name', value });
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selection: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition: string | null;
  selection: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  variables: Array<{ name: string; type: string }>;
  selection: SelectionNode[];
}

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`Expected '${value}' but got ${JSON.stringify(token.value)}`);
    }
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`Expected a name but got ${JSON.stringify(token.value)}`);
    return token.value;
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.peek().kind !== 'eof') {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): OperationNode {
    let operation: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      operation = this.next().value as 'query' | 'mutation';
      if (this.peek().kind === 'name') name = this.next().value;
    }
    const variables: Array<{ name: string; type: string }> = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        let type = '';
        // A type is Name, [Name], Name!, [Name!]!, ... — read until ',' or ')'.
        while (!(this.peek().kind === 'punct' && (this.peek().value === ',' || this.peek().value === ')'))) {
          type += this.next().value;
        }
        variables.push({ name: varName, type });
        if (this.peek().kind === 'punct' && this.peek().value === ',') this.next();
      }
      this.expectPunct(')');
    }
    const selection = this.parseSelectionSet();
    return { operation, name, variables, selection };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      let typeCondition: string | null = null;
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      return { kind: 'fragment', typeCondition, selection: this.parseSelectionSet() };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    // Directives (@include/@skip) are not used by the suite's documents; skip any.
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') {
        let depth = 0;
        do {
          const t = this.next();
          if (t.kind === 'punct' && t.value === '(') depth += 1;
          if (t.kind === 'punct' && t.value === ')') depth -= 1;
        } while (depth > 0);
      }
    }
    let selection: SelectionNode[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '{') {
      selection = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selection };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`Unexpected value token ${JSON.stringify(token.value)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

interface GqlValue {
  __typename: string;
  [key: string]: unknown;
}

interface ExecContext {
  forge: Forge;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
      return node.value;
    case 'int':
      return node.value;
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => valueOf(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = valueOf(arg.value, variables);
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Execute one operation; returns {data} or {data: null, errors}. */
export function executeOperation(
  forge: Forge,
  query: string,
  variables: Record<string, unknown>,
): { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } {
  let operations: OperationNode[];
  try {
    operations = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const operation = operations[0];
  if (!operation) return { data: null, errors: [{ message: 'No operation in document' }] };
  const ctx: ExecContext = { forge, variables, errors: [] };
  const root: GqlValue = { __typename: operation.operation === 'mutation' ? 'Mutation' : 'Query' };
  const data = executeSelection(ctx, root, operation.selection);
  if (ctx.errors.length > 0) return { data: null, errors: ctx.errors };
  return { data: data as Record<string, unknown> };
}

function executeSelection(ctx: ExecContext, parent: GqlValue, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== parent.__typename) continue;
      Object.assign(out, executeSelection(ctx, parent, selection.selection));
      continue;
    }
    const key = selection.alias ?? selection.name;
    out[key] = executeField(ctx, parent, selection);
  }
  return out;
}

function executeField(ctx: ExecContext, parent: GqlValue, field: FieldNode): unknown {
  const typeName = parent.__typename;
  const allowed = TYPE_FIELDS[typeName];
  if (!allowed || !allowed.includes(field.name)) {
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
    return null;
  }
  const args = argsOf(field, ctx.variables);
  const resolved = resolveField(ctx, parent, field.name, args);
  if (resolved === undefined) {
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
    return null;
  }
  if (resolved === null) return null;
  if (field.selection.length === 0) {
    // A scalar (or an object queried without a sub-selection: return as-is).
    if (isGqlValue(resolved)) return resolved;
    return resolved;
  }
  if (Array.isArray(resolved)) {
    return resolved.map((item) => {
      if (item === null) return null;
      if (isGqlValue(item)) return executeSelection(ctx, item, field.selection);
      return item;
    });
  }
  if (isGqlValue(resolved)) return executeSelection(ctx, resolved, field.selection);
  return resolved;
}

function isGqlValue(value: unknown): value is GqlValue {
  return isRecord(value) && typeof value.__typename === 'string';
}

// ---------------------------------------------------------------------------------------------
// resolvers
// ---------------------------------------------------------------------------------------------

function repoValue(repo: Repo): GqlValue {
  return { __typename: 'Repository', __repo: repo };
}

function issueValue(repo: Repo, issue: Issue): GqlValue {
  return { __typename: 'Issue', __repo: repo, __issue: issue };
}

function pullValue(repo: Repo, pull: Pull): GqlValue {
  return { __typename: 'PullRequest', __repo: repo, __pull: pull };
}

function userValue(): GqlValue {
  return { __typename: 'User', login: VIEWER_LOGIN };
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: string): number | null {
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(decoded);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function resolveField(ctx: ExecContext, parent: GqlValue, field: string, args: Record<string, unknown>): unknown {
  const typeName = parent.__typename;
  if (typeName === 'Query') return resolveQuery(ctx, field, args);
  if (typeName === 'Mutation') return resolveMutation(ctx, field, args);
  if (typeName === 'Repository') return resolveRepository(ctx, parent, field, args);
  if (typeName === 'Issue') return resolveIssue(parent, field);
  if (typeName === 'PullRequest') return resolvePullRequest(parent, field, args);
  if (typeName === 'User') return parent[field] ?? null;
  if (typeName === 'Ref') return parent[field] ?? null;
  if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'PullRequestChangedFileConnection') {
    return parent[field] ?? null;
  }
  if (typeName === 'PageInfo') return parent[field] ?? null;
  if (typeName === 'PullRequestChangedFile') return parent[field] ?? null;
  if (typeName === '__Type') return resolveIntrospection(parent, field, args);
  if (typeName === '__Field' || typeName === '__EnumValue') return parent[field] ?? null;
  if (
    typeName === 'CreateIssuePayload' || typeName === 'CloseIssuePayload' ||
    typeName === 'CreatePullRequestPayload' || typeName === 'MergePullRequestPayload' ||
    typeName === 'AddCommentPayload' || typeName === 'IssueCommentEdge' || typeName === 'IssueComment'
  ) {
    return parent[field] ?? null;
  }
  return undefined;
}

function resolveQuery(ctx: ExecContext, field: string, args: Record<string, unknown>): unknown {
  if (field === 'viewer') return userValue();
  if (field === 'repository') {
    const owner = args.owner as string;
    const name = args.name as string;
    const repo = ctx.forge.getRepo(owner, name);
    return repo ? repoValue(repo) : null;
  }
  if (field === 'node') {
    const decoded = decodeGlobalId(String(args.id ?? ''));
    if (!decoded) return null;
    if (decoded.kind === 'Repository' && decoded.parts[0] !== undefined) {
      const repo = findRepoById(ctx.forge, decoded.parts[0]);
      return repo ? repoValue(repo) : null;
    }
    if (decoded.kind === 'Issue' && decoded.parts[0] !== undefined && decoded.parts[1] !== undefined) {
      const repo = findRepoById(ctx.forge, decoded.parts[0]);
      const issue = repo?.issues.find((i) => i.number === decoded.parts[1]);
      return repo && issue ? issueValue(repo, issue) : null;
    }
    if (decoded.kind === 'PullRequest' && decoded.parts[0] !== undefined && decoded.parts[1] !== undefined) {
      const repo = findRepoById(ctx.forge, decoded.parts[0]);
      const pull = repo?.pulls.find((p) => p.number === decoded.parts[1]);
      return repo && pull ? pullValue(repo, pull) : null;
    }
    return null;
  }
  if (field === '__type') {
    const name = String(args.name ?? '');
    return { __typename: '__Type', __typeName: name };
  }
  return undefined;
}

function resolveIntrospection(parent: GqlValue, field: string, _args: Record<string, unknown>): unknown {
  const name = parent.__typeName as string;
  if (field === 'name') return name;
  if (field === 'kind') {
    if (ENUM_VALUES[name]) return 'ENUM';
    if (TYPE_FIELDS[name]) return 'OBJECT';
    return 'OBJECT';
  }
  if (field === 'fields') {
    const fields = TYPE_FIELDS[name] ?? [];
    return fields.map((f) => ({ __typename: '__Field', name: f }));
  }
  if (field === 'enumValues') {
    const values = ENUM_VALUES[name] ?? [];
    return values.map((v) => ({ __typename: '__EnumValue', name: v }));
  }
  if (field === 'description') return null;
  return undefined;
}

function resolveRepository(ctx: ExecContext, parent: GqlValue, field: string, args: Record<string, unknown>): unknown {
  const repo = parent.__repo as Repo;
  switch (field) {
    case 'id':
      return repoGlobalId(repo);
    case 'databaseId':
      return repo.id;
    case 'name':
      return repo.name;
    case 'nameWithOwner':
      return `${repo.owner}/${repo.name}`;
    case 'owner':
      return userValue();
    case 'defaultBranchRef':
      return { __typename: 'Ref', name: repo.defaultBranch };
    case 'viewerPermission':
      return 'ADMIN';
    case 'hasIssuesEnabled':
      return true;
    case 'description':
      return repo.description;
    case 'private':
      return repo.private;
    case 'issue': {
      const number = args.number as number;
      const issue = repo.issues.find((i) => i.number === number);
      return issue ? issueValue(repo, issue) : null;
    }
    case 'issues':
      return issuesConnection(repo, args);
    case 'pullRequests': {
      const first = (args.first as number | undefined) ?? 100;
      const nodes = [...repo.pulls].filter((p) => p.state === 'open').reverse().slice(0, first);
      return {
        __typename: 'PullRequestConnection',
        nodes: nodes.map((p) => pullValue(repo, p)),
        pageInfo: { __typename: 'PageInfo', hasNextPage: false, endCursor: null },
      };
    }
    case 'pullRequest': {
      const number = args.number as number;
      const pull = repo.pulls.find((p) => p.number === number);
      return pull ? pullValue(repo, pull) : null;
    }
    default:
      return undefined;
  }
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): GqlValue {
  const first = (args.first as number | undefined) ?? 100;
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  const orderBy = isRecord(args.orderBy) ? args.orderBy : null;
  const after = typeof args.after === 'string' ? args.after : null;
  let issues = [...repo.issues];
  if (states !== null) {
    const wanted = new Set(states.map((s) => s.toLowerCase()));
    issues = issues.filter((i) => wanted.has(i.state));
  }
  const direction = orderBy?.direction === 'ASC' ? 'ASC' : orderBy?.direction === 'DESC' ? 'DESC' : 'ASC';
  // Default (no orderBy): creation order ascending; CREATED_AT DESC reverses it.
  issues.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
  if (after !== null) {
    const afterNumber = numberFromCursor(after);
    if (afterNumber !== null) {
      issues = direction === 'DESC' ? issues.filter((i) => i.number < afterNumber) : issues.filter((i) => i.number > afterNumber);
    }
  }
  const page = issues.slice(0, first);
  const hasNextPage = issues.length > page.length;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1]!.number) : null;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((i) => issueValue(repo, i)),
    pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor },
  };
}

function resolveIssue(parent: GqlValue, field: string): unknown {
  const repo = parent.__repo as Repo;
  const issue = parent.__issue as Issue;
  switch (field) {
    case 'id':
      return issueGlobalId(repo, issue);
    case 'number':
      return issue.number;
    case 'title':
      return issue.title;
    case 'state':
      return issue.state === 'open' ? 'OPEN' : 'CLOSED';
    case 'body':
      return issue.body;
    case 'author':
      return userValue();
    case 'createdAt':
    case 'updatedAt':
      return FIXED_ISO;
    case 'labels':
      return issue.labels.map((l) => ({ __typename: 'Label', name: l.name, color: l.color }));
    default:
      return undefined;
  }
}

function resolvePullRequest(parent: GqlValue, field: string, args: Record<string, unknown>): unknown {
  const repo = parent.__repo as Repo;
  const pull = parent.__pull as Pull;
  switch (field) {
    case 'id':
      return pullGlobalId(repo, pull);
    case 'number':
      return pull.number;
    case 'title':
      return pull.title;
    case 'body':
      return pull.body;
    case 'state':
      return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    case 'merged':
      return pull.merged;
    case 'headRefName':
      return pull.headRef;
    case 'baseRefName':
      return pull.baseRef;
    case 'mergeable':
      return pullMergeable(repo, pull);
    case 'author':
      return userValue();
    case 'files': {
      const first = (args.first as number | undefined) ?? 100;
      const diff = pullFileDiff(repo, pull).slice(0, first);
      return {
        __typename: 'PullRequestChangedFileConnection',
        nodes: diff.map((f) => ({ __typename: 'PullRequestChangedFile', path: f.filename, additions: f.additions, deletions: f.deletions })),
        pageInfo: { __typename: 'PageInfo', hasNextPage: false, endCursor: null },
      };
    }
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// mutations
// ---------------------------------------------------------------------------------------------

function resolveMutation(ctx: ExecContext, field: string, args: Record<string, unknown>): unknown {
  const input = isRecord(args.input) ? args.input : {};
  if (field === 'createIssue') {
    const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
    if (!decoded || decoded.kind !== 'Repository' || decoded.parts[0] === undefined) {
      ctx.errors.push({ message: 'createIssue: unknown repositoryId' });
      return null;
    }
    const repo = findRepoById(ctx.forge, decoded.parts[0]);
    if (!repo) {
      ctx.errors.push({ message: 'createIssue: unknown repositoryId' });
      return null;
    }
    const title = String(input.title ?? '');
    if (title === '') {
      ctx.errors.push({ message: 'createIssue: title is required' });
      return null;
    }
    const issue: Issue = {
      id: ctx.forge.nextGlobalId(),
      number: ++repo.issueSeq,
      title,
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      labels: [],
      comments: [],
      jsonCache: null,
    };
    repo.issues.push(issue);
    return { __typename: 'CreateIssuePayload', issue: issueValue(repo, issue) };
  }
  if (field === 'closeIssue') {
    const decoded = decodeGlobalId(String(input.issueId ?? ''));
    if (!decoded || decoded.kind !== 'Issue' || decoded.parts[0] === undefined || decoded.parts[1] === undefined) {
      ctx.errors.push({ message: 'closeIssue: unknown issueId' });
      return null;
    }
    const repo = findRepoById(ctx.forge, decoded.parts[0]);
    const issue = repo?.issues.find((i) => i.number === decoded.parts[1]);
    if (!repo || !issue) {
      ctx.errors.push({ message: 'closeIssue: unknown issueId' });
      return null;
    }
    issue.state = 'closed';
    issue.jsonCache = null;
    return { __typename: 'CloseIssuePayload', issue: issueValue(repo, issue) };
  }
  if (field === 'createPullRequest') {
    const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
    if (!decoded || decoded.kind !== 'Repository' || decoded.parts[0] === undefined) {
      ctx.errors.push({ message: 'createPullRequest: unknown repositoryId' });
      return null;
    }
    const repo = findRepoById(ctx.forge, decoded.parts[0]);
    if (!repo) {
      ctx.errors.push({ message: 'createPullRequest: unknown repositoryId' });
      return null;
    }
    const head = String(input.headRefName ?? '');
    const base = String(input.baseRefName ?? '');
    const title = String(input.title ?? '');
    const headTip = repo.refs.get(`refs/heads/${head}`);
    const baseTip = repo.refs.get(`refs/heads/${base}`);
    if (!headTip || !baseTip) {
      ctx.errors.push({ message: 'createPullRequest: head or base branch does not exist' });
      return null;
    }
    if (title === '') {
      ctx.errors.push({ message: 'createPullRequest: title is required' });
      return null;
    }
    const duplicate = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
    if (duplicate) {
      ctx.errors.push({ message: `A pull request already exists for ${head} into ${base}` });
      return null;
    }
    const pull: Pull = {
      id: ctx.forge.nextGlobalId(),
      number: ++repo.pullSeq,
      title,
      body: typeof input.body === 'string' ? input.body : '',
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
    return { __typename: 'CreatePullRequestPayload', pullRequest: pullValue(repo, pull) };
  }
  if (field === 'mergePullRequest') {
    const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
    if (!decoded || decoded.kind !== 'PullRequest' || decoded.parts[0] === undefined || decoded.parts[1] === undefined) {
      ctx.errors.push({ message: 'mergePullRequest: unknown pullRequestId' });
      return null;
    }
    const repo = findRepoById(ctx.forge, decoded.parts[0]);
    const pull = repo?.pulls.find((p) => p.number === decoded.parts[1]);
    if (!repo || !pull) {
      ctx.errors.push({ message: 'mergePullRequest: unknown pullRequestId' });
      return null;
    }
    if (pull.state !== 'open') {
      ctx.errors.push({ message: 'mergePullRequest: the pull request is already closed' });
      return null;
    }
    const method = String(input.mergeMethod ?? 'MERGE');
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (!headTip || !baseTip) {
      ctx.errors.push({ message: 'mergePullRequest: a branch is missing' });
      return null;
    }
    if (isAncestor(repo, headTip, baseTip)) {
      ctx.errors.push({ message: 'mergePullRequest: the head is already merged' });
      return null;
    }
    const baseOid = mergeBase(repo, baseTip, headTip) ?? baseTip;
    const baseCommit = getCommit(repo, baseOid);
    const headCommit = getCommit(repo, headTip);
    const oursCommit = getCommit(repo, baseTip);
    if (!baseCommit || !headCommit || !oursCommit) {
      ctx.errors.push({ message: 'mergePullRequest: a commit is missing' });
      return null;
    }
    const merged = mergeFlatTrees(
      repo,
      flattenTree(repo, baseCommit.tree),
      flattenTree(repo, oursCommit.tree),
      flattenTree(repo, headCommit.tree),
    );
    if (merged.conflict) {
      ctx.errors.push({ message: 'mergePullRequest: merge conflict' });
      return null;
    }
    const treeOid = buildTreeFromMap(repo, merged.merged);
    const squash = method === 'SQUASH';
    const parents = squash ? [baseTip] : [baseTip, headTip];
    const message = squash ? `${pull.title} (#${pull.number})` : `Merge pull request #${pull.number} from ${pull.headRef}`;
    const commitOid = createCommit(repo, treeOid, parents, message);
    setBranch(repo, pull.baseRef, commitOid);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = FIXED_ISO;
    pull.mergeCommitSha = commitOid;
    pull.baseSha = commitOid;
    return { __typename: 'MergePullRequestPayload', pullRequest: pullValue(repo, pull) };
  }
  if (field === 'addComment') {
    const decoded = decodeGlobalId(String(input.subjectId ?? ''));
    if (!decoded || decoded.kind !== 'Issue' || decoded.parts[0] === undefined || decoded.parts[1] === undefined) {
      ctx.errors.push({ message: 'addComment: unknown subjectId' });
      return null;
    }
    const repo = findRepoById(ctx.forge, decoded.parts[0]);
    const issue = repo?.issues.find((i) => i.number === decoded.parts[1]);
    if (!repo || !issue) {
      ctx.errors.push({ message: 'addComment: unknown subjectId' });
      return null;
    }
    const body = typeof input.body === 'string' ? input.body : '';
    const comment = { id: ctx.forge.nextGlobalId(), body };
    issue.comments.push(comment);
    issue.jsonCache = null;
    return {
      __typename: 'AddCommentPayload',
      commentEdge: {
        __typename: 'IssueCommentEdge',
        node: { __typename: 'IssueComment', id: commentGlobalId(repo, issue, comment), body },
      },
    };
  }
  return undefined;
}
