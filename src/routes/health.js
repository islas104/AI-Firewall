/** Liveness/readiness — verifies the budget store before reporting healthy. */
import { Router } from 'express';

export function healthRouter({ redis }) {
  const router = Router();

  // Public liveness probe — intentionally minimal so it discloses no config
  // (limits/upstream mode) to anonymous callers. Operators read those from
  // the admin-gated /admin/agents fleet block instead.
  router.get('/healthz', async (_req, res) => {
    try {
      await redis.ping();
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'degraded' });
    }
  });

  return router;
}
