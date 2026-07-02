/**
 * Per-agent request rate limiting (fixed one-minute window in Redis).
 * Budget ceilings cap dollars; this caps request *velocity* — a runaway loop
 * of cheap calls gets throttled long before it burns budget or hammers OpenAI.
 *
 * RATE_LIMIT_RPM=0 disables the limiter entirely.
 * Redis failure here fails OPEN by design: the budget reserve immediately
 * downstream fails CLOSED, so no unmetered spend can slip through — but a
 * blip in Redis shouldn't double-punish traffic that is about to be rejected
 * by the budget check anyway.
 */
import { errorBody } from '../errors.js';

export function agentRateLimit({ config, redis, metrics }) {
  if (!config.rateLimitRpm) {
    return (_req, _res, next) => next();
  }

  return async (req, res, next) => {
    const agentId = req.header('X-Agent-ID');
    if (!agentId) return next(); // the chat route rejects missing ids with 400

    const minute = Math.floor(Date.now() / 60000);
    const key = `agent:ratelimit:${agentId}:${minute}`;
    try {
      const [[, count]] = await redis.multi().incr(key).expire(key, 120).exec();
      res.set('X-RateLimit-Limit', String(config.rateLimitRpm));
      res.set('X-RateLimit-Remaining', String(Math.max(0, config.rateLimitRpm - Number(count))));
      if (Number(count) > config.rateLimitRpm) {
        metrics?.rateLimited.inc();
        res.set('Retry-After', String(60 - Math.floor((Date.now() / 1000) % 60)));
        return res
          .status(429)
          .json(errorBody(`Rate limit exceeded: ${config.rateLimitRpm} requests/minute per agent.`, 'rate_limited'));
      }
      next();
    } catch (err) {
      (req.log ?? console).error(`[ratelimit] Redis error, failing open: ${err.message}`);
      next();
    }
  };
}
