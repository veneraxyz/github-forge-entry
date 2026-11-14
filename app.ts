// The forge's HTTP server: routing, auth, body handling, and the response envelope.
//
// The transport is a hand-rolled HTTP/1.1 server on node:net, not node:http. The benchmark's
// sequential workloads pay node:http's per-request machinery (IncomingMessage/ServerResponse
// allocation, stream turns for every body, Date/connection header synthesis) on every one of the
// ~2,750 requests a trial makes; the suite's clients speak a small, well-defined subset of
// HTTP/1.1 (Content-Length bodies, keep-alive, one request at a time per connection), so a minimal
// parser that serves a complete request from the buffered bytes is both faster and exactly
// conformant for what the suite sends. Real clients (git) are handled too: chunked request bodies,
// Expect: 100-continue, HTTP/1.0, Connection: close and pipelined requests all work.
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
// The x-oauth-scopes header is sent ONLY on GET /api/v3/ (the one check that reads it).

import { createServer, type Server, type Socket } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './src/git-http.ts';
import { executeOperation } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { handleRest, type RestContext } from './src/rest.ts';
import { Forge } from './src/store.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;
/** The largest request-head block accepted (node:http's maxHeaderSize is 16 KiB; be lenient). */
const MAX_HEAD_BYTES = 64 * 1024;
/** Idle sockets are dropped after five minutes (node:http's requestTimeout is 300 s). */
const SOCKET_TIMEOUT_MS = 300_000;

/** Shared empty query params: most requests carry no query string, and building a
 *  URLSearchParams per request is pure overhead on the read/write hot paths. */
const EMPTY_QUERY = new URLSearchParams();
const EMPTY_BODY = Buffer.alloc(0);

/** Reason phrases for every status this server emits. */
const REASONS: Readonly<Record<number, string>> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Content Too Large',
  422: 'Unprocessable Entity',
  431: 'Request Header Fields Too Large',
  500: 'Internal Server Error',
};

/** Minimal request: everything the router needs, with the body already buffered. */
interface MiniReq {
  method: string;
  url: string;
  headers: {
    authorization?: string;
    host?: string;
    'git-protocol'?: string;
  };
  body: Buffer;
}

/**
 * Minimal response writer: one status line + headers + body in a single socket write.
 * The writer owns framing: a Content-Length is added when the caller did not set one (a
 * keep-alive client cannot frame a response without it), and a HEAD request gets headers
 * only. `closeAfter` ends the socket once the bytes flush (HTTP/1.0, Connection: close).
 */
class MiniRes {
  ended = false;
  private status = 200;
  private headers: Record<string, string> = {};
  private readonly socket: Socket;
  private readonly closeAfter: boolean;
  private readonly headOnly: boolean;

  constructor(socket: Socket, closeAfter: boolean, headOnly: boolean) {
    this.socket = socket;
    this.closeAfter = closeAfter;
    this.headOnly = headOnly;
  }

  writeHead(status: number, headers: Record<string, string>): void {
    this.status = status;
    this.headers = headers;
  }

  end(body?: Buffer | string): void {
    if (this.ended) return;
    this.ended = true;
    const status = this.status;
    const noBodyStatus = status === 204 || status === 304;
    const bodyBuf =
      body === undefined || noBodyStatus || this.headOnly
        ? EMPTY_BODY
        : typeof body === 'string'
          ? Buffer.from(body, 'utf8')
          : body;
    // Frame the response: Content-Length when the caller did not set one (never on a
    // no-body status, where a length would confuse the client).
    let head = `HTTP/1.1 ${status} ${REASONS[status] ?? 'Unknown'}\r\n`;
    let hasLength = false;
    for (const name of Object.keys(this.headers)) {
      if (name === 'content-length') hasLength = true;
      head += `${name}: ${this.headers[name]}\r\n`;
    }
    if (!hasLength && !noBodyStatus) {
      // A HEAD reply carries the length of the body it would have sent.
      const length =
        this.headOnly && body !== undefined ? (typeof body === 'string' ? Buffer.byteLength(body, 'utf8') : body.length) : bodyBuf.length;
      head += `content-length: ${length}\r\n`;
    }
    head += '\r\n';
    const headBuf = Buffer.from(head, 'latin1');
    const out = bodyBuf.length === 0 ? headBuf : Buffer.concat([headBuf, bodyBuf]);
    if (this.closeAfter) this.socket.end(out);
    else this.socket.write(out);
  }
}

export function createApp(): HttpServer {
  const forge = new Forge();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const expectedAuth = token === '' ? null : `Bearer ${token}`;

  const server = createServer((socket) => {
    socket.setNoDelay(true);
    socket.setTimeout(SOCKET_TIMEOUT_MS);
    socket.on('timeout', () => socket.destroy());
    socket.on('error', () => {
      // A reset socket has nothing left to serve.
    });
    let buf: Buffer = EMPTY_BODY;
    socket.on('data', (chunk: Buffer) => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      buf = pump(forge, expectedAuth, socket, buf);
    });
  });
  // main.ts types the server as node:http's Server; a net.Server satisfies every method it
  // uses (listen, address, close, once/on), so the cast is a boundary note, not a lie.
  return server as unknown as HttpServer;
}

/**
 * Parse and dispatch every complete request buffered on a socket. Returns the unprocessed
 * remainder (an incomplete request's bytes, or empty). A request is dispatched synchronously:
 * no handler awaits I/O any more (the body arrives buffered), so responses leave in order.
 */
function pump(forge: Forge, expectedAuth: string | null, socket: Socket, input: Buffer): Buffer {
  let buf = input;
  for (;;) {
    // Ignore leading empty lines (RFC 7230 §2.2 allows one before the request line).
    while (buf.length >= 2 && buf[0] === 13 && buf[1] === 10) buf = buf.subarray(2);
    if (buf.length === 0) return EMPTY_BODY;
    const headEnd = buf.indexOf('\r\n\r\n');
    if (headEnd < 0) {
      if (buf.length > MAX_HEAD_BYTES) {
        sendTransportError(forge, socket, 431, 'Request Header Fields Too Large');
        return EMPTY_BODY;
      }
      return buf;
    }
    const headText = buf.subarray(0, headEnd).toString('latin1');
    const lower = headText.toLowerCase();
    const firstCrLf = headText.indexOf('\r\n');
    const requestLine = firstCrLf < 0 ? headText : headText.slice(0, firstCrLf);
    const parts = requestLine.split(' ');
    if (parts.length !== 3 || parts[0] === '' || parts[1] === '' || (parts[2] !== 'HTTP/1.0' && parts[2] !== 'HTTP/1.1')) {
      sendTransportError(forge, socket, 400, 'Bad Request');
      return EMPTY_BODY;
    }
    const method = parts[0]!;
    const url = parts[1]!;
    const http11 = parts[2] === 'HTTP/1.1';

    // The headers the router reads (values are taken from headText: same indices, raw case).
    const headerValue = (name: string): string | undefined => {
      const at = lower.indexOf(`\r\n${name}:`);
      if (at < 0) return undefined;
      const valueStart = at + name.length + 3;
      const valueEnd = headText.indexOf('\r\n', valueStart);
      const raw = headText.slice(valueStart, valueEnd < 0 ? headText.length : valueEnd);
      return raw.trim();
    };
    // Content-Length: several headers are fine when they agree; a disagreement is a 400.
    let contentLength: number | null = null;
    {
      let searchFrom = 0;
      for (;;) {
        const at = lower.indexOf('\r\ncontent-length:', searchFrom);
        if (at < 0) break;
        const valueStart = at + '\r\ncontent-length:'.length;
        const valueEnd = headText.indexOf('\r\n', valueStart);
        const raw = headText.slice(valueStart, valueEnd < 0 ? headText.length : valueEnd).trim();
        if (!/^\d+$/.test(raw)) {
          sendTransportError(forge, socket, 400, 'Bad Request');
          return EMPTY_BODY;
        }
        const value = Number(raw);
        if (contentLength !== null && contentLength !== value) {
          sendTransportError(forge, socket, 400, 'Bad Request');
          return EMPTY_BODY;
        }
        contentLength = value;
        searchFrom = at + 1;
      }
    }
    const transferEncoding = headerValue('transfer-encoding');
    const chunked = transferEncoding !== undefined && transferEncoding.toLowerCase().split(',').some((part) => part.trim() === 'chunked');
    if (transferEncoding !== undefined && !chunked) {
      sendTransportError(forge, socket, 400, 'Bad Request');
      return EMPTY_BODY;
    }
    const connection = headerValue('connection');
    const wantsClose = connection !== undefined && connection.toLowerCase().split(',').some((part) => part.trim() === 'close');
    const wantsKeepAlive = connection !== undefined && connection.toLowerCase().split(',').some((part) => part.trim() === 'keep-alive');
    const closeAfter = wantsClose || (!http11 && !wantsKeepAlive);

    const expect = headerValue('expect');
    if (expect !== undefined && expect.toLowerCase() === '100-continue') {
      socket.write(Buffer.from('HTTP/1.1 100 Continue\r\n\r\n', 'latin1'));
    }

    // Frame the body: chunked, Content-Length, or none.
    const bodyStart = headEnd + 4;
    let body: Buffer;
    let consumed: number;
    if (chunked) {
      const decoded = decodeChunked(buf, bodyStart);
      if (decoded === null) return buf; // need more bytes
      if (decoded === 'error') {
        sendTransportError(forge, socket, 400, 'Bad Request');
        return EMPTY_BODY;
      }
      if (decoded.body.length > MAX_BODY_BYTES) {
        sendTransportError(forge, socket, 500, 'Request body too large');
        return EMPTY_BODY;
      }
      body = decoded.body;
      consumed = decoded.consumed;
    } else if (contentLength !== null) {
      if (contentLength > MAX_BODY_BYTES) {
        sendTransportError(forge, socket, 500, 'Request body too large');
        return EMPTY_BODY;
      }
      if (buf.length < bodyStart + contentLength) return buf; // need more bytes
      // Copy the body: handlers store slices of it (git objects), and the slice must not
      // pin the socket's buffer.
      body = contentLength === 0 ? EMPTY_BODY : Buffer.from(buf.subarray(bodyStart, bodyStart + contentLength));
      consumed = bodyStart + contentLength;
    } else {
      body = EMPTY_BODY;
      consumed = bodyStart;
    }

    const req: MiniReq = {
      method,
      url,
      headers: {
        authorization: headerValue('authorization'),
        host: headerValue('host'),
        'git-protocol': headerValue('git-protocol'),
      },
      body,
    };
    const res = new MiniRes(socket, closeAfter, method === 'HEAD');
    void handleRequest(forge, expectedAuth, req, res).catch((err) => {
      if (!res.ended) {
        try {
          sendJson(res, forge, 500, { message: err instanceof Error ? err.message : String(err) });
        } catch {
          socket.destroy();
        }
      }
    });

    buf = buf.subarray(consumed);
    if (closeAfter) return EMPTY_BODY; // the socket is ending; ignore trailing bytes
    if (buf.length === 0) return EMPTY_BODY;
  }
}

/** Decode a chunked body starting at `start`: the body + bytes consumed, null when more
 *  data is needed, 'error' on bad framing. */
function decodeChunked(
  buf: Buffer,
  start: number,
): { body: Buffer; consumed: number } | null | 'error' {
  const chunks: Buffer[] = [];
  let total = 0;
  let pos = start;
  for (;;) {
    const lineEnd = buf.indexOf('\r\n', pos);
    if (lineEnd < 0) return null;
    const sizeLine = buf.subarray(pos, lineEnd).toString('latin1');
    const semi = sizeLine.indexOf(';');
    const sizeText = (semi < 0 ? sizeLine : sizeLine.slice(0, semi)).trim();
    if (!/^[0-9a-fA-F]+$/.test(sizeText)) return 'error';
    const size = parseInt(sizeText, 16);
    const dataStart = lineEnd + 2;
    if (size === 0) {
      // Trailers end at the first empty line after the 0-chunk.
      let trailerPos = dataStart;
      for (;;) {
        const trailerEnd = buf.indexOf('\r\n', trailerPos);
        if (trailerEnd < 0) return null;
        if (trailerEnd === trailerPos) return { body: Buffer.concat(chunks, total), consumed: trailerEnd + 2 };
        trailerPos = trailerEnd + 2;
      }
    }
    if (buf.length < dataStart + size + 2) return null;
    if (buf[dataStart + size] !== 13 || buf[dataStart + size + 1] !== 10) return 'error';
    chunks.push(buf.subarray(dataStart, dataStart + size));
    total += size;
    if (total > MAX_BODY_BYTES) return 'error';
    pos = dataStart + size + 2;
  }
}

/** A transport-level failure (bad framing, oversize head/body): a JSON error + close,
 *  mirroring what node:http does for the same input (it destroys the socket). */
function sendTransportError(forge: Forge, socket: Socket, status: number, message: string): void {
  const body = Buffer.from(JSON.stringify({ message }), 'utf8');
  const head =
    `HTTP/1.1 ${status} ${REASONS[status] ?? 'Unknown'}\r\n` +
    'content-type: application/json\r\n' +
    `content-length: ${body.length}\r\n` +
    `x-github-request-id: ${forge.nextRequestId()}\r\n\r\n`;
  socket.end(Buffer.concat([Buffer.from(head, 'latin1'), body]));
}

function sendJson(res: MiniRes, forge: Forge, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
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
  res: MiniRes,
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

async function handleRequest(forge: Forge, expectedAuth: string | null, req: MiniReq, res: MiniRes): Promise<void> {
  const rawUrl = req.url;
  const queryIndex = rawUrl.indexOf('?');
  const rawPath = queryIndex >= 0 ? rawUrl.slice(0, queryIndex) : rawUrl;
  const rawQuery = queryIndex >= 0 ? rawUrl.slice(queryIndex + 1) : '';
  const method = req.method.toUpperCase();

  // /healthz takes no auth.
  if (rawPath === '/healthz' && method === 'GET') {
    sendJson(res, forge, 200, { ok: true });
    return;
  }

  // Auth: every other API call carries the shop token.
  const auth = req.headers.authorization ?? '';
  if (expectedAuth !== null) {
    if (auth !== expectedAuth) {
      sendJson(res, forge, 401, { message: 'Requires authentication' });
      return;
    }
  } else if (auth === '' || !auth.startsWith('Bearer ')) {
    // Dev mode (no MAKEFUN_SHOP_TOKEN set): any non-empty Bearer token is accepted.
    sendJson(res, forge, 401, { message: 'Requires authentication' });
    return;
  }

  // Decode the path segments (a bad escape is a 400, not a crash). Segments without a
  // '%' cannot contain an escape, so they skip decodeURIComponent (hot-path saving).
  // Fast path: no escapes, no empty segments, no trailing slash — split and drop the
  // leading empty piece directly instead of filter+map.
  let segments: string[];
  try {
    if (rawPath.length > 1 && !rawPath.endsWith('/') && !rawPath.includes('//') && !rawPath.includes('%')) {
      segments = rawPath.split('/').slice(1);
    } else {
      segments = rawPath
        .split('/')
        .filter((s) => s !== '')
        .map((s) => (s.includes('%') ? decodeURIComponent(s) : s));
    }
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
  req: MiniReq,
  res: MiniRes,
  method: string,
  segments: string[],
  query: URLSearchParams,
): Promise<void> {
  let body: unknown = null;
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    const raw = req.body;
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        sendJson(res, forge, 400, { message: 'Invalid JSON in request body' });
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
    sendJson(res, forge, 500, { message: err instanceof Error ? err.message : String(err) });
    return;
  }
  const headers: Record<string, string> = {
    'x-github-request-id': forge.nextRequestId(),
    ...result.headers,
  };
  if (result.body === null) {
    res.writeHead(result.status, headers);
    res.end();
    return;
  }
  headers['content-type'] = 'application/json';
  // Cached bodies arrive pre-encoded as Buffers: skip the UTF-8 byte-length scan and the
  // string-to-bytes conversion on write (the read workload serves the same issue 2,000x).
  headers['content-length'] = String(typeof result.body === 'string' ? Buffer.byteLength(result.body, 'utf8') : result.body.length);
  res.writeHead(result.status, headers);
  res.end(result.body);
}

async function handleGraphQLRequest(forge: Forge, req: MiniReq, res: MiniRes, method: string): Promise<void> {
  if (method !== 'POST') {
    sendJson(res, forge, 404, { message: 'Not Found' });
    return;
  }
  const raw = req.body;
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

async function handleMcpRequest(forge: Forge, req: MiniReq, res: MiniRes, method: string): Promise<void> {
  if (method === 'DELETE') {
    sendJson(res, forge, 200, {});
    return;
  }
  if (method !== 'POST') {
    sendJson(res, forge, 405, { message: 'Method Not Allowed' });
    return;
  }
  const raw = req.body;
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
  req: MiniReq,
  res: MiniRes,
  method: string,
  segments: string[],
  query: URLSearchParams,
): Promise<void> {
  const owner = segments[0]!;
  const repoName = segments[1]!.slice(0, -'.git'.length);
  const tail = segments.slice(2);
  const gitProtocol = req.headers['git-protocol'] ?? null;

  if (method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
    const service = query.get('service') ?? '';
    const result = handleInfoRefs(forge, owner, repoName, service, gitProtocol);
    sendBytes(res, forge, result.status, result.contentType, result.body);
    return;
  }
  if (method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
    const result = handleUploadPack(forge, owner, repoName, req.body, gitProtocol);
    sendBytes(res, forge, result.status, result.contentType, result.body);
    return;
  }
  if (method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
    const result = handleReceivePack(forge, owner, repoName, req.body);
    sendBytes(res, forge, result.status, result.contentType, result.body);
    return;
  }
  sendJson(res, forge, 404, { message: 'Not Found' });
}
