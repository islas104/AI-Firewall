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

function fixedWindowLimiter({ redis, metrics, limitRpm, keyFor, label }) {
  return async (req, res, next) => {
    const subject = keyFor(req);
    if (!subject) return next();

    const minute = Math.floor(Date.now() / 60000);
    const key = `${label}:ratelimit:${subject}:${minute}`;
    try {
      const [[, count]] = await redis.multi().incr(key).expire(key, 120).exec();
      res.set('X-RateLimit-Limit', String(limitRpm));
      res.set('X-RateLimit-Remaining', String(Math.max(0, limitRpm - Number(count))));
      if (Number(count) > limitRpm) {
        metrics?.rateLimited.inc();
        res.set('Retry-After', String(60 - Math.floor((Date.now() / 1000) % 60)));
        return res
          .status(429)
          .json(errorBody(`Rate limit exceeded: ${limitRpm} requests/minute per ${label}.`, 'rate_limited'));
      }
      next();
    } catch (err) {
      (req.log ?? console).error(`[ratelimit] Redis error, failing open: ${err.message}`);
      next();
    }
  };
}

/** Per-agent velocity brake (agents identified by X-Agent-ID). */
export function agentRateLimit({ config, redis, metrics }) {
  if (!config.rateLimitRpm) {
    return (_req, _res, next) => next();
  }
  return fixedWindowLimiter({
    redis,
    metrics,
    limitRpm: config.rateLimitRpm,
    // Missing ids fall through — the chat route rejects them with 400.
    keyFor: (req) => req.header('X-Agent-ID'),
    label: 'agent',
  });
}

/**
 * Per-IP brake, applied BEFORE auth — so unauthenticated attackers hammering
 * the surface with 401s get throttled too. Requires trust proxy to be set
 * correctly behind a load balancer (TRUST_PROXY).
 */
export function ipRateLimit({ config, redis, metrics }) {
  const limitRpm = config.ipRateLimitRpm ?? 0;
  if (!limitRpm) {
    return (_req, _res, next) => next();
  }
  return fixedWindowLimiter({
    redis,
    metrics,
    limitRpm,
    keyFor: (req) => req.ip,
    label: 'ip',
  });
}
