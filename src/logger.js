/**
 * Structured logging (pino). Every request gets a UUID correlation id, and
 * secrets (Authorization / X-Admin-Key headers) are redacted before they can
 * ever reach a log sink.
 */
import crypto from 'node:crypto';
import pino from 'pino';
import pinoHttp from 'pino-http';

export function createLogger(level = 'info') {
  return pino({
    level,
    base: { service: 'ai-firewall' },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export function createHttpLogger(logger) {
  return pinoHttp({
    logger,
    genReqId: () => crypto.randomUUID(),
    // Health probes and metric scrapes fire every few seconds — logging them
    // would drown real traffic.
    autoLogging: {
      ignore: (req) => req.url === '/healthz' || req.url === '/metrics',
    },
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    redact: {
      paths: ['req.headers.authorization', 'req.headers["x-admin-key"]'],
      censor: '[REDACTED]',
    },
  });
}
