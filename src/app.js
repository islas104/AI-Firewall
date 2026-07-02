/**
 * App factory. Dependencies are injected so tests can assemble the app with a
 * mock upstream (or a scoped Redis) without touching the network.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { chatRouter } from './routes/chat.js';
import { adminRouter } from './routes/admin.js';
import { healthRouter } from './routes/health.js';
import { proxyAuth, adminAuth } from './middleware/auth.js';
import { errorBody } from './errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp({ config, redis, budget, upstream }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  // Public surfaces
  app.use(healthRouter({ config, redis }));
  app.get('/dashboard', (_req, res) =>
    res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html')),
  );

  // Proxy surface (Bearer auth when PROXY_API_KEY is set)
  const requireProxyKey = proxyAuth(config);
  app.use('/v1', requireProxyKey);
  app.use(chatRouter({ config, budget, upstream }));

  // Back-compat public budget lookup (same auth as the proxy surface)
  app.get('/v1/budget/:agentId', async (req, res) => {
    try {
      res.json(await budget.getStatus(req.params.agentId));
    } catch (err) {
      console.error('[budget] lookup failed:', err.message);
      res.status(503).json(errorBody('Budget store unavailable.', 'store_unavailable'));
    }
  });

  // Admin surface (X-Admin-Key auth when ADMIN_API_KEY is set)
  app.use('/admin', adminAuth(config));
  app.use(adminRouter({ config, budget }));

  // Fallback 404 in OpenAI's error shape.
  app.use((_req, res) => res.status(404).json(errorBody('Not found.', 'not_found')));

  // Last-resort error handler — malformed JSON bodies land here too.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json(errorBody('Request body is not valid JSON.', 'invalid_json'));
    }
    console.error('[app] unhandled error:', err);
    res.status(500).json(errorBody('Internal proxy error.', 'internal_error'));
  });

  return app;
}
