// Dev harness (not part of the graded entry): start the forge on a fixed port with a test
// token so sdk/run.ts can grade it locally.
//
//   MAKEFUN_SHOP_TOKEN=dev-token node --experimental-strip-types dev.ts [port]
//   node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:PORT --token dev-token [--perf]
//
// Defaults: port 18711, token "dev-token" (set MAKEFUN_SHOP_TOKEN to override the token).

import { createApp } from './app.ts';

const port = Number(process.argv[2] ?? '18711');
if (process.env.MAKEFUN_SHOP_TOKEN === undefined || process.env.MAKEFUN_SHOP_TOKEN === '') {
  process.env.MAKEFUN_SHOP_TOKEN = 'dev-token';
}

const server = createApp();
server.listen(port, () => {
  process.stdout.write(`[dev] forge listening on http://127.0.0.1:${port} (token: ${process.env.MAKEFUN_SHOP_TOKEN})\n`);
});
server.on('error', (err) => {
  process.stderr.write(`[dev] ${err.message}\n`);
  process.exit(1);
});
