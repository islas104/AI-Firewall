/**
 * Optional auth layers. Both keys are opt-in: unset means open (fine for
 * local development; a warning is logged so production misconfiguration is
 * loud). Comparisons are constant-time to prevent timing side-channels.
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

/** Bearer auth for the proxy surface (/v1/*). Active when PROXY_API_KEY is set. */
export function proxyAuth(config) {
  if (!config.proxyApiKey) {
    return (_req, _res, next) => next();
  }
  return (req, res, next) => {
    const header = req.header('Authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!safeEqual(token, config.proxyApiKey)) {
      return res.status(401).json(errorBody('Invalid or missing proxy API key.', 'unauthorized'));
    }
    next();
  };
}

/** X-Admin-Key auth for the admin surface. Active when ADMIN_API_KEY is set. */
export function adminAuth(config, logger = console) {
  if (!config.adminApiKey) {
    logger.warn('[auth] ADMIN_API_KEY not set — admin endpoints are unauthenticated.');
    return (_req, _res, next) => next();
  }
  return (req, res, next) => {
    if (!safeEqual(req.header('X-Admin-Key') ?? '', config.adminApiKey)) {
      return res.status(401).json(errorBody('Invalid or missing admin key.', 'unauthorized'));
    }
    next();
  };
}
