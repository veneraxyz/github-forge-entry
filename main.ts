// Forge entrypoint: start the HTTP server, announce it to the trial suite, and
// stay alive until the suite reports that it is done.
//
// Boot handshake, as the trial expects it:
//   1. Bind an ephemeral port (port 0 and let the kernel pick; never 8080,
//      which is where the suite itself listens).
//   2. POST {"port": <that port>} to $MAKEFUN_ENV_URL/register so the suite
//      knows where to dial.
//   3. Keep serving while polling GET $MAKEFUN_ENV_URL/done. The suite
//      answers {"done": false} while it still has checks and timed workloads
//      to run, and {"done": true} once its export is written. On the true
//      answer this process shuts the server down and exits 0.
//
// A process that dies, crashes, or never registers before the boot budget
// runs out leaves no working forge behind and scores zero, so neither the
// register step nor the polling loop ever gives up on a transient failure:
// a failed attempt is retried for as long as it takes, and only the
// explicit {"done": true} answer ends the run.

import { createApp } from './app.ts';
import { request as httpRequest, type Server } from 'node:http';
import { request as httpsRequest } from 'node:https';

// How long to wait between retries, and how long one request may hang
// before it is abandoned and retried.
const RETRY_DELAY_MS = 500;
const REQUEST_TIMEOUT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface JsonReply {
  status: number;
  payload: unknown;
}

// One JSON round trip against the suite's env server. `body` is serialised
// when given; the reply is parsed as JSON when it parses, and left as raw
// text otherwise. A request that hangs past the timeout, or fails on the
// network, rejects so the caller can retry it.
function jsonRoundTrip(
  envBase: string,
  path: string,
  method: 'GET' | 'POST',
  body?: unknown,
): Promise<JsonReply> {
  return new Promise((resolve, reject) => {
    const target = new URL(path, envBase);
    const text = body === undefined ? '' : JSON.stringify(body);
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(
      target,
      {
        method,
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(text, 'utf8')),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = raw;
          try {
            parsed = JSON.parse(raw);
          } catch {
            // Not JSON: keep the raw text so the caller can still inspect it.
          }
          resolve({ status: res.statusCode ?? 0, payload: parsed });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`request to ${path} timed out`));
    });
    req.end(text);
  });
}

// Bind the forge to an ephemeral port and report which port the kernel gave.
function bindEphemeral(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('server bound to an unexpected address'));
        return;
      }
      resolve(address.port);
    });
  });
}

// Announce the forge's port to the suite, retrying until it sticks. A 2xx
// means the registration landed; a 409 means a registration is already on
// record (an earlier attempt whose reply was lost), which counts as
// registered too. Anything else is retried: the suite starts beside this
// process, so it may simply not be answering yet.
async function announce(envBase: string, port: number): Promise<void> {
  for (;;) {
    try {
      const reply = await jsonRoundTrip(envBase, '/register', 'POST', { port });
      if (reply.status === 409) return;
      if (reply.status >= 200 && reply.status < 300) return;
      console.error(`[main] register answered HTTP ${reply.status}, retrying`);
    } catch (err) {
      console.error(`[main] register failed, retrying: ${err instanceof Error ? err.message : String(err)}`);
    }
    await sleep(RETRY_DELAY_MS);
  }
}

// Poll /done until the suite says it is finished. A poll that errors, or a
// reply that is not the expected shape, is treated as "not done yet" rather
// than as a reason to die: only {"done": true} ends the run.
async function waitUntilDone(envBase: string): Promise<void> {
  for (;;) {
    try {
      const reply = await jsonRoundTrip(envBase, '/done', 'GET');
      if (
        reply.status >= 200 &&
        reply.status < 300 &&
        typeof reply.payload === 'object' &&
        reply.payload !== null &&
        (reply.payload as Record<string, unknown>).done === true
      ) {
        return;
      }
    } catch (err) {
      console.error(`[main] /done poll failed, retrying: ${err instanceof Error ? err.message : String(err)}`);
    }
    await sleep(RETRY_DELAY_MS);
  }
}

async function boot(): Promise<void> {
  const envBase = process.env.MAKEFUN_ENV_URL;
  if (envBase === undefined || envBase === '') {
    console.error('[main] MAKEFUN_ENV_URL is not set; nothing to register with.');
    process.exit(1);
  }
  const server = createApp();
  const port = await bindEphemeral(server);
  await announce(envBase, port);
  await waitUntilDone(envBase);
  server.close();
}

boot()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(`[main] fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
