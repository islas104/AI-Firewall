/**
 * Optional auth layers. Both keys are opt-in: unset means open (fine for
 * local development; a warning is logged so production misconfiguration is
 * loud). Comparisons are constant-time to prevent timing side-channels.
 *
 * Failed attempts are throttled per IP: after AUTH_FAIL_LIMIT_PER_MIN wrong
 * keys in a minute, further attempts get 429 before any comparison runs —
 * brute force gets slower, not warmer.
 */
import { timingSafeEqual } from 'node:crypto';
import { errorBody } from '../errors.js';

/** Constant-time string comparison. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// Surface-scoped so failures on the public /v1 surface can't exhaust the
// admin surface's brute-force allowance (and vice versa).
function failKey(surface, ip) {
  return `authfail:${surface}:${ip}:${Math.floor(Date.now() / 60000)}`;
}

/** True if this IP has burned through its failed-attempt allowance. */
async function isLockedOut(redis, surface, ip, limit) {
  if (!redis || !limit) return false;
  try {
    const count = await redis.get(failKey(surface, ip));
    return Number(count ?? 0) >= limit;
  } catch {
    return false; // Redis blip — the key comparison still protects us
  }
}

async function recordFailure(redis, surface, ip, metrics, logger) {
  metrics?.authFailures.inc();
  logger?.warn?.(`[auth] failed ${surface} auth attempt from ip=${ip}`);
  if (!redis) return;
  const key = failKey(surface, ip);
  try {
    await redis.multi().incr(key).expire(key, 120).exec();
  } catch {
    /* counting is best-effort */
  }
}

const LOCKOUT_BODY = errorBody('Too many failed authentication attempts. Try again in a minute.', 'auth_lockout');

/** Bearer auth for the proxy surface (/v1/*). Active when PROXY_API_KEY is set. */
export function proxyAuth({ config, redis, metrics, logger = console }) {
  if (!config.proxyApiKey) {
    return (_req, _res, next) => next();
  }
  const failLimit = config.authFailLimitPerMin ?? 0;
  return async (req, res, next) => {
    if (await isLockedOut(redis, 'proxy', req.ip, failLimit)) {
      res.set('Retry-After', '60');
      return res.status(429).json(LOCKOUT_BODY);
    }
    const header = req.header('Authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!safeEqual(token, config.proxyApiKey)) {
      await recordFailure(redis, 'proxy', req.ip, metrics, req.log ?? logger);
      return res.status(401).json(errorBody('Invalid or missing proxy API key.', 'unauthorized'));
    }
    next();
  };
}

/** X-Admin-Key auth for the admin surface. Active when ADMIN_API_KEY is set. */
export function adminAuth({ config, redis, metrics, logger = console }) {
  if (!config.adminApiKey) {
    logger.warn('[auth] ADMIN_API_KEY not set — admin endpoints are unauthenticated.');
    return (_req, _res, next) => next();
  }
  const failLimit = config.authFailLimitPerMin ?? 0;
  return async (req, res, next) => {
    if (await isLockedOut(redis, 'admin', req.ip, failLimit)) {
      res.set('Retry-After', '60');
      return res.status(429).json(LOCKOUT_BODY);
    }
    if (!safeEqual(req.header('X-Admin-Key') ?? '', config.adminApiKey)) {
      await recordFailure(redis, 'admin', req.ip, metrics, req.log ?? logger);
      return res.status(401).json(errorBody('Invalid or missing admin key.', 'unauthorized'));
    }
    next();
  };
}
