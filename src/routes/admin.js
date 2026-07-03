/**
 * Admin surface: agent fleet overview, per-agent limit overrides, and spend
 * resets. Protected by X-Admin-Key when ADMIN_API_KEY is set. Powers the
 * dashboard at /dashboard.
 */
import { Router } from 'express';
import { errorBody } from '../errors.js';
import { isValidAgentId } from '../budget.js';

/** Structured, greppable audit trail for every state-changing admin action. */
function audit(req, action, details) {
  (req.log ?? console).warn(
    { audit: true, action, actorIp: req.ip, ...details },
    `[audit] ${action} ${JSON.stringify(details)} by ip=${req.ip}`,
  );
}

export function adminRouter({ config, budget }) {
  const router = Router();

  // Validate every :agentId path param once — rejects the reserved
  // __global__ ledger id and any malformed/injection value with a 400.
  router.param('agentId', (req, res, next, agentId) => {
    if (!isValidAgentId(agentId)) {
      return res.status(400).json(errorBody('Invalid agent id.', 'invalid_agent_id'));
    }
    next();
  });

  /** Fleet overview — every agent seen today with spend/limit/status. */
  router.get('/admin/agents', async (_req, res) => {
    try {
      const [agents, global] = await Promise.all([budget.listAgents(), budget.getGlobalStatus()]);
      res.json({
        day: agents[0]?.day ?? new Date().toISOString().slice(0, 10),
        perAgentLimitUsd: config.hardDailyLimitUsd,
        globalLimitUsd: config.hardDailyLimitUsd, // kept for dashboard back-compat
        totalDailyLimitUsd: config.totalDailyLimitUsd,
        upstream: config.mockUpstream ? 'mock' : 'openai',
        fleet: global,
        agents,
      });
    } catch (err) {
      console.error('[admin] list failed:', err.message);
      res.status(503).json(errorBody('Budget store unavailable.', 'store_unavailable'));
    }
  });

  /** Single-agent status (also mounted publicly as /v1/budget/:agentId). */
  router.get('/admin/agents/:agentId', async (req, res) => {
    try {
      res.json(await budget.getStatus(req.params.agentId));
    } catch (err) {
      console.error('[admin] status failed:', err.message);
      res.status(503).json(errorBody('Budget store unavailable.', 'store_unavailable'));
    }
  });

  /** Set or clear a per-agent daily limit. Body: {"limitUsd": 25} or {"limitUsd": null}. */
  router.put('/admin/agents/:agentId/limit', async (req, res) => {
    const { limitUsd } = req.body ?? {};
    const clearing = limitUsd === null;
    if (!clearing && (!Number.isFinite(limitUsd) || limitUsd < 0)) {
      return res
        .status(400)
        .json(errorBody('"limitUsd" must be a non-negative number, or null to clear the override.', 'invalid_request'));
    }
    try {
      const status = await budget.setLimit(req.params.agentId, clearing ? null : limitUsd);
      audit(req, 'set_agent_limit', { agentId: req.params.agentId, limitUsd: clearing ? null : limitUsd });
      res.json(status);
    } catch (err) {
      console.error('[admin] set limit failed:', err.message);
      res.status(503).json(errorBody('Budget store unavailable.', 'store_unavailable'));
    }
  });

  /** Reset today's spend for an agent — un-trips the kill-switch. */
  router.delete('/admin/agents/:agentId/spend', async (req, res) => {
    try {
      const status = await budget.resetSpend(req.params.agentId);
      audit(req, 'reset_agent_spend', { agentId: req.params.agentId });
      res.json(status);
    } catch (err) {
      console.error('[admin] reset failed:', err.message);
      res.status(503).json(errorBody('Budget store unavailable.', 'store_unavailable'));
    }
  });

  return router;
}
