/** Liveness/readiness — verifies the budget store before reporting healthy. */
import { Router } from 'express';

export function healthRouter({ config, redis }) {
  const router = Router();

  router.get('/healthz', async (_req, res) => {
    try {
      await redis.ping();
      res.json({
        status: 'ok',
        redis: 'up',
        upstream: config.mockUpstream ? 'mock' : 'openai',
        limitUsd: config.hardDailyLimitUsd,
      });
    } catch {
      res.status(503).json({ status: 'degraded', redis: 'down' });
    }
  });

  return router;
}
