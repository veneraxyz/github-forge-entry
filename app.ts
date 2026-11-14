// The forge's HTTP server: routing, auth, body handling, and the response envelope.
//
// Routes:
//   GET  /healthz                                  200 {"ok":true}, no auth
//   /api/v3/...                                    GitHub REST v3 (src/rest.ts)
//   POST /api/graphql                             GraphQL v4 (src/graphql.ts)
//   POST /mcp                                     MCP streamable HTTP (src/mcp.ts)
//   /{owner}/{repo}.git/info/refs                 git smart-HTTP advertisement
//   POST /{owner}/{repo}.git/git-upload-pack      git fetch/clone
//   POST /{owner}/{repo}.git/git-receive-pack     git push
//
// Every API call carries `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; anything else is 401.
// Every reply carries a non-empty X-GitHub-Request-Id. Every REST reply is application/json.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './src/git-http.ts';
import { executeOperation } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { handleRest, type RestContext } from './src/rest.ts';
import { Forge } from './src/store.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** Shared empty query params: most requests carry no query string, and building a
 *  URLSearchParams per request is pure overhead on the read/write hot paths. */
const EMPTY_QUERY = new URLSearchParams();

export function createApp(): Server {
  const forge = new Forge();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const expectedAuth = token === '' ? null : `Bearer ${token}`;

  const server = createServer((req, res) => {
    void handleRequest(forge, expectedAuth, req, res).catch((err) => {
      try {
        sendJson(res, forge, 500, { message: err instanceof Error ? err.message : String(err) });
      } catch {
        try {
          res.destroy();
        } catch {
          // The socket is already gone.
        }
      }
    });
  });
  return server;
}

function sendJson(res: ServerResponse, forge: Forge, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(text, 'utf8')),
    'x-github-request-id': forge.nextRequestId(),
    ...extraHeaders,
  };
  res.writeHead(status, headers);
  res.end(text);
}

function sendBytes(
  res: ServerResponse,
  forge: Forge,
  status: number,
  contentType: string,
  body: Buffer,
  extraHeaders?: Record<string, string>,
): void {
  const headers: Record<string, string> = {
    'content-type': contentType,
    'content-length': String(body.length),
    'x-github-request-id': forge.nextRequestId(),
    ...extraHeaders,
  };
  res.writeHead(status, headers);
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks, total)));
    req.on('error', reject);
  });
}

async function handleRequest(forge: Forge, expectedAuth: string | null, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const rawUrl = req.url ?? '/';
  const queryIndex = rawUrl.indexOf('?');
  const rawPath = queryIndex >= 0 ? rawUrl.slice(0, queryIndex) : rawUrl;
  const rawQuery = queryIndex >= 0 ? rawUrl.slice(queryIndex + 1) : '';
  const method = (req.method ?? 'GET').toUpperCase();

  // /healthz takes no auth.
  if (rawPath === '/healthz' && method === 'GET') {
    sendJson(res, forge, 200, { ok: true });
    return;
  }

  // Auth: every other API call carries the shop token.
  const auth = req.headers.authorization ?? '';
  if (expectedAuth !== null) {
    if (auth !== expectedAuth) {
      sendJson(res, forge, 401, { message: 'Requires authentication' }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }
  } else if (auth === '' || !auth.startsWith('Bearer ')) {
    // Dev mode (no MAKEFUN_SHOP_TOKEN set): any non-empty Bearer token is accepted.
    sendJson(res, forge, 401, { message: 'Requires authentication' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }

  // Decode the path segments (a bad escape is a 400, not a crash). Segments without a
  // '%' cannot contain an escape, so they skip decodeURIComponent (hot-path saving).
  let segments: string[];
  try {
    segments = rawPath
      .split('/')
      .filter((s) => s !== '')
      .map((s) => (s.includes('%') ? decodeURIComponent(s) : s));
  } catch {
    sendJson(res, forge, 400, { message: 'Bad path encoding' });
    return;
  }
  const query = rawQuery === '' ? EMPTY_QUERY : new URLSearchParams(rawQuery);

  // REST v3.
  if (segments[0] === 'api' && segments[1] === 'v3') {
    await handleRestRequest(forge, req, res, method, segments.slice(2), query);
    return;
  }

  // GraphQL.
  if (segments[0] === 'api' && segments[1] === 'graphql' && segments.length === 2) {
    await handleGraphQLRequest(forge, req, res, method);
    return;
  }

  // MCP.
  if (segments[0] === 'mcp' && segments.length === 1) {
    await handleMcpRequest(forge, req, res, method);
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  if (segments.length >= 2 && segments[1]!.endsWith('.git')) {
    await handleGitRequest(forge, req, res, method, segments, query);
    return;
  }

  sendJson(res, forge, 404, { message: 'Not Found' });
}

async function handleRestRequest(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  segments: string[],
  query: URLSearchParams,
): Promise<void> {
  let body: unknown = null;
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    const raw = await readBody(req);
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        sendJson(res, forge, 400, { message: 'Invalid JSON in request body' }, { 'x-oauth-scopes': 'repo, read:org' });
        return;
      }
    }
  }
  const host = req.headers.host ?? '127.0.0.1';
  const ctx: RestContext = { forge, method, segments, query, body, host };
  let result;
  try {
    result = handleRest(ctx);
  } catch (err) {
    sendJson(res, forge, 500, { message: err instanceof Error ? err.message : String(err) }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  const headers: Record<string, string> = {
    'x-github-request-id': forge.nextRequestId(),
    'x-oauth-scopes': 'repo, read:org',
    ...result.headers,
  };
  if (result.body === null) {
    res.writeHead(result.status, headers);
    res.end();
    return;
  }
  headers['content-type'] = 'application/json';
  headers['content-length'] = String(Buffer.byteLength(result.body, 'utf8'));
  res.writeHead(result.status, headers);
  res.end(result.body);
}

async function handleGraphQLRequest(forge: Forge, req: IncomingMessage, res: ServerResponse, method: string): Promise<void> {
  if (method !== 'POST') {
    sendJson(res, forge, 404, { message: 'Not Found' });
    return;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, forge, 400, { message: 'Invalid JSON in request body' });
    return;
  }
  const runOne = (op: unknown): Record<string, unknown> => {
    if (op === null || typeof op !== 'object' || Array.isArray(op)) {
      return { data: null, errors: [{ message: 'Must provide an operation object.' }] };
    }
    const record = op as Record<string, unknown>;
    const queryText = record.query;
    if (typeof queryText !== 'string') {
      return { data: null, errors: [{ message: 'Must provide query string.' }] };
    }
    const variables = record.variables !== null && typeof record.variables === 'object' && !Array.isArray(record.variables)
      ? (record.variables as Record<string, unknown>)
      : {};
    return executeOperation(forge, queryText, variables);
  };
  if (Array.isArray(parsed)) {
    sendJson(res, forge, 200, parsed.map(runOne));
    return;
  }
  sendJson(res, forge, 200, runOne(parsed));
}

async function handleMcpRequest(forge: Forge, req: IncomingMessage, res: ServerResponse, method: string): Promise<void> {
  if (method === 'DELETE') {
    sendJson(res, forge, 200, {});
    return;
  }
  if (method !== 'POST') {
    sendJson(res, forge, 405, { message: 'Method Not Allowed' });
    return;
  }
  const raw = await readBody(req);
  let result;
  try {
    result = handleMcp(forge, raw.toString('utf8'));
  } catch (err) {
    sendJson(res, forge, 500, { message: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (result.body === null) {
    res.writeHead(result.status, { 'x-github-request-id': forge.nextRequestId() });
    res.end();
    return;
  }
  sendJson(res, forge, result.status, result.body);
}

async function handleGitRequest(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  segments: string[],
  query: URLSearchParams,
): Promise<void> {
  const owner = segments[0]!;
  const repoName = segments[1]!.slice(0, -'.git'.length);
  const tail = segments.slice(2);
  const gitProtocolHeader = req.headers['git-protocol'];
  const gitProtocol = typeof gitProtocolHeader === 'string' ? gitProtocolHeader : null;

  if (method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
    const service = query.get('service') ?? '';
    const result = handleInfoRefs(forge, owner, repoName, service, gitProtocol);
    sendBytes(res, forge, result.status, result.contentType, result.body);
    return;
  }
  if (method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
    const body = await readBody(req);
    const result = handleUploadPack(forge, owner, repoName, body, gitProtocol);
    sendBytes(res, forge, result.status, result.contentType, result.body);
    return;
  }
  if (method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
    const body = await readBody(req);
    const result = handleReceivePack(forge, owner, repoName, body);
    sendBytes(res, forge, result.status, result.contentType, result.body);
    return;
  }
  sendJson(res, forge, 404, { message: 'Not Found' });
}
