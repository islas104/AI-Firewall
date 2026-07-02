/**
 * AI Agent Budget Proxy — entrypoint.
 *
 * Wires config → Redis → budget store → upstream → Express app, then handles
 * graceful shutdown and process-level failure. All logic lives in src/;
 * this file only assembles it.
 */
import { config, validateConfig } from './src/config.js';
import { createRedis } from './src/redis.js';
import { createBudgetStore } from './src/budget.js';
import { createUpstream } from './src/upstream.js';
import { createApp } from './src/app.js';
import { createLogger } from './src/logger.js';
import { createMetrics } from './src/metrics.js';

const logger = createLogger(config.logLevel);

try {
  validateConfig();
} catch (err) {
  logger.fatal(err.message);
  process.exit(1);
}

const redis = createRedis(config.redisUrl);
const budget = createBudgetStore(redis, config);
const upstream = createUpstream(config);
const metrics = createMetrics();
const app = createApp({ config, redis, budget, upstream, logger, metrics });

const server = app.listen(config.port, () => {
  logger.info(
    `[proxy] listening on :${config.port} | daily limit $${config.hardDailyLimitUsd} | ` +
      `rate limit ${config.rateLimitRpm || 'off'}/min | upstream ${upstream.name}`,
  );
  logger.info(`[proxy] dashboard http://localhost:${config.port}/dashboard | metrics /metrics`);
  if (!config.proxyApiKey) logger.warn('[proxy] PROXY_API_KEY not set — proxy surface is unauthenticated.');
});

// Keep-alive tuning: must exceed the LB's idle timeout to avoid racing FINs.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

// --- Graceful shutdown -------------------------------------------------------

const DRAIN_GRACE_MS = 8_000;
const HARD_EXIT_MS = 10_000;
let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`[proxy] ${signal} received — draining connections.`);

  server.close(() => {
    redis.quit().finally(() => process.exit(0));
  });
  server.closeIdleConnections();

  // In-flight requests (including SSE streams) get a grace window, then the
  // remaining sockets are closed so the process can exit.
  setTimeout(() => server.closeAllConnections(), DRAIN_GRACE_MS).unref();
  setTimeout(() => process.exit(1), HARD_EXIT_MS).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// --- Last-resort failure handling ---------------------------------------------
// An unknown-state process must not keep accepting traffic that spends money.

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, '[proxy] uncaught exception — exiting');
  shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, '[proxy] unhandled promise rejection');
});
