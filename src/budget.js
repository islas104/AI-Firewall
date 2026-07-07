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

/** The last `n` UTC day strings, oldest → newest (includes today). */
function recentDays(n) {
  const today = Date.parse(currentDay() + 'T00:00:00Z');
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    out.push(new Date(today - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

const spentKey = (agentId, day) => `agent:budget:spent:${agentId}:${day}`;
const pendingKey = (agentId, day) => `agent:budget:pending:${agentId}:${day}`;
const limitKey = (agentId) => `agent:budget:limit:${agentId}`;
const agentsKey = (day) => `agent:budget:agents:${day}`;

// Persistent spend history (survives the 48h daily-key TTL). One hash per
// agent, field = day, value = that day's committed spend. A roster set lets
// the export enumerate every agent that has ever spent.
const historyKey = (agentId) => `agent:budget:history:${agentId}`;
const ROSTER_KEY = 'agent:budget:roster';

// Fleet-wide ledger. '__global__' cannot collide with a real agent: the
// chat route's agent-ID regex requires an alphanumeric first character.
const GLOBAL_ID = '__global__';

// Same alphabet the chat route enforces. Routes that take :agentId from the
// URL (budget lookup, admin) must apply this too, or a caller could address
// the reserved GLOBAL_ID ledger or inject Redis key segments.
const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** True if `id` is a safe, non-reserved agent identifier. */
export function isValidAgentId(id) {
  return typeof id === 'string' && id !== GLOBAL_ID && AGENT_ID_RE.test(id);
}

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
    // Register the agent for dashboard discovery ONLY when a reservation
    // actually succeeded. Registering on rejected requests let an attacker
    // bloat this SET (and the O(N) /admin/agents fan-out) with rotating IDs
    // at zero budget cost.
    if (status === 'ok') {
      await redis
        .multi()
        .sadd(agentsKey(day), agentId)
        .expire(agentsKey(day), config.spentKeyTtlSeconds)
        .exec();
    }
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
    // Persist to long-term history so spend survives the daily-key TTL and can
    // be exported. Only real spend is recorded (keeps the roster bounded to
    // agents that actually cost money). Best-effort — never fail a commit.
    if (actualCost > 0) {
      const ttl = config.historyRetentionDays * 24 * 60 * 60;
      try {
        await redis
          .multi()
          .hincrbyfloat(historyKey(agentId), day, actualCost)
          .expire(historyKey(agentId), ttl)
          .sadd(ROSTER_KEY, agentId)
          .exec();
      } catch {
        /* history is best-effort; the authoritative ledger already committed */
      }
    }
    return Number(newTotal);
  }

  /**
   * Per-agent spend history for the last `days` UTC days (default 30).
   * Returns { generatedAt: null, days, agents: [{agentId, total, byDay}] }.
   * generatedAt is filled by the caller (scripts can't read the clock).
   */
  async function getHistory(days = 30) {
    const roster = await redis.smembers(ROSTER_KEY);
    const wanted = recentDays(days);
    const wantedSet = new Set(wanted);
    const rows = await Promise.all(
      roster.map(async (agentId) => {
        const all = await redis.hgetall(historyKey(agentId));
        const byDay = {};
        let total = 0;
        for (const [day, amt] of Object.entries(all)) {
          if (!wantedSet.has(day)) continue;
          const v = roundUsd(Number(amt));
          byDay[day] = v;
          total += v;
        }
        return { agentId, total: roundUsd(total), byDay };
      }),
    );
    return {
      days: wanted,
      agents: rows.filter((r) => r.total > 0).sort((a, b) => b.total - a.total),
    };
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

  return {
    reserve,
    commit,
    getStatus,
    getGlobalStatus,
    getHistory,
    listAgents,
    setLimit,
    resetSpend,
    getLimit,
  };
}
