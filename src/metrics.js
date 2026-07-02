/**
 * Prometheus metrics. Each app instance owns its own Registry (no global
 * state), exposed at GET /metrics behind admin auth.
 *
 * Label cardinality is kept bounded on purpose: routes are only labelled when
 * Express matched a parameterized route ('/v1/chat/completions', not raw
 * paths), and agent ids are deliberately NOT metric labels — per-agent detail
 * lives in Redis and the admin API, not in Prometheus.
 */
import client from 'prom-client';

export function createMetrics() {
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });

  const httpRequests = new client.Counter({
    name: 'http_requests_total',
    help: 'HTTP requests by method, route, and status',
    labelNames: ['method', 'route', 'status'],
    registers: [registry],
  });

  const httpDuration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
    registers: [registry],
  });

  const spendUsd = new client.Counter({
    name: 'agent_spend_usd_total',
    help: 'Total metered spend across all agents (USD)',
    registers: [registry],
  });

  const budgetHalts = new client.Counter({
    name: 'budget_halts_total',
    help: 'Requests rejected by the 402 kill-switch',
    registers: [registry],
  });

  const budgetContention = new client.Counter({
    name: 'budget_contention_total',
    help: 'Requests deferred (429) because in-flight reservations hold the remaining budget',
    registers: [registry],
  });

  const rateLimited = new client.Counter({
    name: 'rate_limited_total',
    help: 'Requests rejected by the per-agent request rate limit',
    registers: [registry],
  });

  const upstreamErrors = new client.Counter({
    name: 'upstream_errors_total',
    help: 'Failed upstream (OpenAI) calls',
    registers: [registry],
  });

  const globalBudgetHalts = new client.Counter({
    name: 'global_budget_halts_total',
    help: 'Requests rejected because the fleet-wide daily budget is exhausted',
    registers: [registry],
  });

  const authFailures = new client.Counter({
    name: 'auth_failures_total',
    help: 'Failed authentication attempts (proxy + admin surfaces)',
    registers: [registry],
  });

  return {
    registry,
    httpRequests,
    httpDuration,
    spendUsd,
    budgetHalts,
    globalBudgetHalts,
    budgetContention,
    rateLimited,
    upstreamErrors,
    authFailures,
  };
}

/** Times every request; unmatched paths collapse to one label value. */
export function metricsMiddleware(metrics) {
  return (req, res, next) => {
    const endTimer = metrics.httpDuration.startTimer();
    res.on('finish', () => {
      const route = req.route ? (req.baseUrl ?? '') + req.route.path : 'unmatched';
      const labels = { method: req.method, route, status: String(res.statusCode) };
      metrics.httpRequests.inc(labels);
      endTimer(labels);
    });
    next();
  };
}
