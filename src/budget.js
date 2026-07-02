/**
 * Budget domain logic: key layout, reserve/commit lifecycle, per-agent limit
 * overrides, and the agent registry that powers the dashboard.
 *
 * Key layout:
 *   agent:budget:spent:{agentId}:{YYYY-MM-DD}    committed spend (TTL 48h)
 *   agent:budget:pending:{agentId}:{YYYY-MM-DD}  in-flight reservations (TTL 10m)
 *   agent:budget:limit:{agentId}                 per-agent limit override (persistent)
 *   agent:budget:agents:{YYYY-MM-DD}             set of agents seen today (TTL 48h)
 */
import { roundUsd } from './pricing.js';

/** UTC calendar day, e.g. "2026-07-02". UTC keeps the boundary stable. */
export function currentDay() {
  return new Date().toISOString().slice(0, 10);
}

const spentKey = (agentId, day) => `agent:budget:spent:${agentId}:${day}`;
const pendingKey = (agentId, day) => `agent:budget:pending:${agentId}:${day}`;
const limitKey = (agentId) => `agent:budget:limit:${agentId}`;
const agentsKey = (day) => `agent:budget:agents:${day}`;

// Fleet-wide ledger. '__global__' cannot collide with a real agent: the
// chat route's agent-ID regex requires an alphanumeric first character.
const GLOBAL_ID = '__global__';

export function createBudgetStore(redis, config) {
  /** Effective limit: per-agent override if set, else the global ceiling. */
  async function getLimit(agentId) {
    const override = await redis.get(limitKey(agentId));
    return override === null ? config.hardDailyLimitUsd : Number(override);
  }

  /**
   * Atomically reserve `estimate` USD for an in-flight request, against both
   * the agent's daily budget and the fleet-wide global budget.
   * Returns { status: 'ok'|'halt'|'halt_global'|'defer', spent, pending, limit }.
   */
  async function reserve(agentId, estimate) {
    const day = currentDay();
    const limit = await getLimit(agentId);
    const globalLimit = config.totalDailyLimitUsd ?? 0; // 0 = disabled
    const [status, spent, pending] = await redis.reserveBudget(
      spentKey(agentId, day),
      pendingKey(agentId, day),
      spentKey(GLOBAL_ID, day),
      pendingKey(GLOBAL_ID, day),
      String(limit),
      String(globalLimit),
      String(estimate),
      String(config.pendingKeyTtlSeconds),
    );
    // Register the agent for dashboard discovery (fire-and-forget semantics,
    // but awaited so errors surface in logs via the caller's catch).
    await redis
      .multi()
      .sadd(agentsKey(day), agentId)
      .expire(agentsKey(day), config.spentKeyTtlSeconds)
      .exec();
    return { status, spent: Number(spent), pending: Number(pending), limit };
  }

  /**
   * Release the reservation and record what the call actually cost.
   * Pass actualCost = 0 to release after an upstream failure.
   * Returns the new committed total.
   */
  async function commit(agentId, actualCost, reservedEstimate) {
    const day = currentDay();
    const newTotal = await redis.commitSpend(
      spentKey(agentId, day),
      pendingKey(agentId, day),
      spentKey(GLOBAL_ID, day),
      pendingKey(GLOBAL_ID, day),
      String(actualCost),
      String(reservedEstimate),
      String(config.spentKeyTtlSeconds),
    );
    return Number(newTotal);
  }

  /** Fleet-wide spend status for today. */
  async function getGlobalStatus() {
    const day = currentDay();
    const [spentRaw, pendingRaw] = await Promise.all([
      redis.get(spentKey(GLOBAL_ID, day)),
      redis.get(pendingKey(GLOBAL_ID, day)),
    ]);
    const spent = spentRaw ? Number(spentRaw) : 0;
    const limit = config.totalDailyLimitUsd ?? 0;
    return {
      day,
      totalSpentUsd: roundUsd(spent),
      totalPendingUsd: roundUsd(pendingRaw ? Number(pendingRaw) : 0),
      totalLimitUsd: limit,
      totalRemainingUsd: limit > 0 ? roundUsd(Math.max(0, limit - spent)) : null,
      exceeded: limit > 0 && spent >= limit,
    };
  }

  /** Full budget status for one agent (today). */
  async function getStatus(agentId) {
    const day = currentDay();
    const [spentRaw, pendingRaw, limit] = await Promise.all([
      redis.get(spentKey(agentId, day)),
      redis.get(pendingKey(agentId, day)),
      getLimit(agentId),
    ]);
    const spent = spentRaw ? Number(spentRaw) : 0;
    const pending = pendingRaw ? Number(pendingRaw) : 0;
    return {
      agentId,
      day,
      spentUsd: roundUsd(spent),
      pendingUsd: roundUsd(pending),
      limitUsd: limit,
      remainingUsd: roundUsd(Math.max(0, limit - spent)),
      exceeded: spent >= limit,
      customLimit: limit !== config.hardDailyLimitUsd,
    };
  }

  /** All agents seen today, with their status — powers the dashboard. */
  async function listAgents() {
    const ids = await redis.smembers(agentsKey(currentDay()));
    const statuses = await Promise.all(ids.map((id) => getStatus(id)));
    return statuses.sort((a, b) => b.spentUsd - a.spentUsd);
  }

  /** Set (or clear with null) a per-agent daily limit override. */
  async function setLimit(agentId, limitUsd) {
    if (limitUsd === null) {
      await redis.del(limitKey(agentId));
    } else {
      await redis.set(limitKey(agentId), String(limitUsd));
    }
    return getStatus(agentId);
  }

  /** Reset today's spend for an agent (un-trips the kill-switch). */
  async function resetSpend(agentId) {
    const day = currentDay();
    await redis.del(spentKey(agentId, day), pendingKey(agentId, day));
    return getStatus(agentId);
  }

  return { reserve, commit, getStatus, getGlobalStatus, listAgents, setLimit, resetSpend, getLimit };
}
