/**
 * AI Agent Budget Proxy — entrypoint.
 *
 * Wires config → Redis → budget store → upstream → Express app, then handles
 * graceful shutdown. All logic lives in src/; this file only assembles it.
 */
import { config, validateConfig } from './src/config.js';
import { createRedis } from './src/redis.js';
import { createBudgetStore } from './src/budget.js';
import { createUpstream } from './src/upstream.js';
import { createApp } from './src/app.js';

try {
  validateConfig();
} catch (err) {
  console.error(`[fatal] ${err.message}`);
  process.exit(1);
}

const redis = createRedis(config.redisUrl);
const budget = createBudgetStore(redis, config);
const upstream = createUpstream(config);
const app = createApp({ config, redis, budget, upstream });

const server = app.listen(config.port, () => {
  console.log(
    `[proxy] listening on :${config.port} | daily limit $${config.hardDailyLimitUsd} | ` +
      `upstream ${upstream.name} | redis ${config.redisUrl}`,
  );
  console.log(`[proxy] dashboard → http://localhost:${config.port}/dashboard`);
});

function shutdown(signal) {
  console.log(`[proxy] ${signal} received — shutting down.`);
  server.close(() => {
    redis.quit().finally(() => process.exit(0));
  });
  // Hard stop if graceful close hangs (e.g. a stuck SSE stream).
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
