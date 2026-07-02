/**
 * Optional auth layers. Both keys are opt-in: unset means open (fine for
 * local development, log a warning so production misconfiguration is loud).
 */
import { errorBody } from '../errors.js';

/** Bearer auth for the proxy surface (/v1/*). Active when PROXY_API_KEY is set. */
export function proxyAuth(config) {
  if (!config.proxyApiKey) {
    return (_req, _res, next) => next();
  }
  return (req, res, next) => {
    const header = req.header('Authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (token !== config.proxyApiKey) {
      return res.status(401).json(errorBody('Invalid or missing proxy API key.', 'unauthorized'));
    }
    next();
  };
}

/** X-Admin-Key auth for the admin surface. Active when ADMIN_API_KEY is set. */
export function adminAuth(config) {
  if (!config.adminApiKey) {
    console.warn('[auth] ADMIN_API_KEY not set — admin endpoints are unauthenticated.');
    return (_req, _res, next) => next();
  }
  return (req, res, next) => {
    if (req.header('X-Admin-Key') !== config.adminApiKey) {
      return res.status(401).json(errorBody('Invalid or missing admin key.', 'unauthorized'));
    }
    next();
  };
}
