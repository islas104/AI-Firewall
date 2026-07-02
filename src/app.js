/**
 * App factory. Dependencies are injected so tests can assemble the app with a
 * mock upstream (or a scoped Redis) without touching the network.
 *
 * Middleware order matters:
 *   security headers → request logging → metrics timing → JSON parsing →
 *   public routes → [auth → rate limit → proxy routes] → [auth → admin] → 404
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { chatRouter } from './routes/chat.js';
import { adminRouter } from './routes/admin.js';
import { healthRouter } from './routes/health.js';
import { proxyAuth, adminAuth } from './middleware/auth.js';
import { securityHeaders } from './middleware/security.js';
import { agentRateLimit, ipRateLimit } from './middleware/rateLimit.js';
import { createLogger, createHttpLogger } from './logger.js';
import { createMetrics, metricsMiddleware } from './metrics.js';
import { errorBody } from './errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

export function createApp({ config, redis, budget, upstream, logger, metrics }) {
  logger ??= createLogger(config.logLevel ?? 'info');
  metrics ??= createMetrics();

  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);

  app.use(securityHeaders(config));
  app.use(createHttpLogger(logger));
  app.use(metricsMiddleware(metrics));
  app.use(express.json({ limit: '2mb' }));

  // Public surfaces
  app.use(healthRouter({ config, redis }));
  app.get('/dashboard', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'dashboard.html')));
  app.get('/dashboard.js', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'dashboard.js')));

  // Proxy surface. Order: per-IP brake (throttles 401 hammering too) →
  // auth (with failed-attempt lockout) → per-agent brake → the proxy itself.
  app.use('/v1', ipRateLimit({ config, redis, metrics }));
  app.use('/v1', proxyAuth({ config, redis, metrics, logger }));
  app.use('/v1', agentRateLimit({ config, redis, metrics }));
  app.use(chatRouter({ config, budget, upstream, metrics }));

  // Back-compat public budget lookup (same auth as the proxy surface)
  app.get('/v1/budget/:agentId', async (req, res) => {
    try {
      res.json(await budget.getStatus(req.params.agentId));
    } catch (err) {
      (req.log ?? console).error(`[budget] lookup failed: ${err.message}`);
      res.status(503).json(errorBody('Budget store unavailable.', 'store_unavailable'));
    }
  });

  // Admin surface (X-Admin-Key auth when ADMIN_API_KEY is set)
  const requireAdminKey = adminAuth({ config, redis, metrics, logger });
  app.use('/admin', requireAdminKey);
  app.use(adminRouter({ config, budget }));

  // Prometheus metrics — protected like the admin surface (scrape with the
  // X-Admin-Key header when ADMIN_API_KEY is set).
  app.get('/metrics', requireAdminKey, async (_req, res) => {
    res.set('Content-Type', metrics.registry.contentType);
    res.end(await metrics.registry.metrics());
  });

  // Fallback 404 in OpenAI's error shape.
  app.use((_req, res) => res.status(404).json(errorBody('Not found.', 'not_found')));

  // Last-resort error handler — malformed JSON bodies land here too.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json(errorBody('Request body is not valid JSON.', 'invalid_json'));
    }
    if (err?.type === 'entity.too.large') {
      return res.status(413).json(errorBody('Request body exceeds the 2mb limit.', 'payload_too_large'));
    }
    (req.log ?? logger).error({ err }, '[app] unhandled error');
    res.status(500).json(errorBody('Internal proxy error.', 'internal_error'));
  });

  return app;
}
