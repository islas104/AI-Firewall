/**
 * Redis client factory with the two Lua commands that make budget enforcement
 * atomic. Lua scripts execute as a single unit inside Redis, so concurrent
 * requests can never race between "check the budget" and "reserve funds".
 *
 * Both scripts operate on TWO ledgers at once: the agent's own daily budget
 * and a fleet-wide global budget. The global cap closes the agent-ID rotation
 * loophole — without it, a leaked proxy key could mint fresh agent IDs, each
 * with a fresh daily budget.
 */
import Redis from 'ioredis';

/**
 * reserveBudget(agentSpent, agentPending, globalSpent, globalPending,
 *               agentLimit, globalLimit, estimate, pendingTtl)
 *
 * Atomically:
 *  - HALT        if the agent's committed spend ≥ its limit
 *  - HALT_GLOBAL if fleet-wide committed spend ≥ the global limit (when > 0)
 *  - DEFER       if spend + in-flight reservations + estimate would exceed
 *                either ceiling (remaining budget is reserved by concurrent
 *                requests)
 *  - OK          otherwise: reserve `estimate` in both pending counters
 *
 * globalLimit of 0 disables the global check (per-agent still applies).
 * Returns { status, spent, pending } for the agent (stringified numbers).
 */
const RESERVE_LUA = `
local aSpent = tonumber(redis.call('GET', KEYS[1]) or '0')
local aPending = tonumber(redis.call('GET', KEYS[2]) or '0')
local aLimit = tonumber(ARGV[1])
local gLimit = tonumber(ARGV[2])
local estimate = tonumber(ARGV[3])
if aSpent >= aLimit then
  return {'halt', tostring(aSpent), tostring(aPending)}
end
if gLimit > 0 then
  local gSpent = tonumber(redis.call('GET', KEYS[3]) or '0')
  local gPending = tonumber(redis.call('GET', KEYS[4]) or '0')
  if gSpent >= gLimit then
    return {'halt_global', tostring(aSpent), tostring(aPending)}
  end
  if gSpent + gPending + estimate > gLimit then
    return {'defer', tostring(aSpent), tostring(aPending)}
  end
end
if aSpent + aPending + estimate > aLimit then
  return {'defer', tostring(aSpent), tostring(aPending)}
end
redis.call('INCRBYFLOAT', KEYS[2], ARGV[3])
redis.call('EXPIRE', KEYS[2], ARGV[4])
redis.call('INCRBYFLOAT', KEYS[4], ARGV[3])
redis.call('EXPIRE', KEYS[4], ARGV[4])
return {'ok', tostring(aSpent), tostring(aPending + estimate)}
`;

/**
 * commitSpend(agentSpent, agentPending, globalSpent, globalPending,
 *             actualCost, reservedEstimate, spentTtl)
 *
 * Atomically release the reservation and record the actual cost on both
 * ledgers. Called with actualCost = 0 to release after an upstream failure.
 * Returns the agent's new committed total.
 */
const COMMIT_LUA = `
local spent = redis.call('INCRBYFLOAT', KEYS[1], ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[3])
local pending = tonumber(redis.call('INCRBYFLOAT', KEYS[2], '-' .. ARGV[2]))
if pending <= 0 then redis.call('DEL', KEYS[2]) end
redis.call('INCRBYFLOAT', KEYS[3], ARGV[1])
redis.call('EXPIRE', KEYS[3], ARGV[3])
local gPending = tonumber(redis.call('INCRBYFLOAT', KEYS[4], '-' .. ARGV[2]))
if gPending <= 0 then redis.call('DEL', KEYS[4]) end
return spent
`;

export function createRedis(redisUrl) {
  const redis = new Redis(redisUrl, {
    // Keep failures loud and bounded rather than silently queueing forever.
    maxRetriesPerRequest: 2,
    lazyConnect: false,
    // Reconnect with capped exponential backoff instead of hammering a
    // recovering Redis. Requests during the outage fail fast (fail-closed
    // budget semantics) rather than queueing.
    retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
  });

  redis.defineCommand('reserveBudget', { numberOfKeys: 4, lua: RESERVE_LUA });
  redis.defineCommand('commitSpend', { numberOfKeys: 4, lua: COMMIT_LUA });

  redis.on('error', (err) => console.error('[redis] connection error:', err.message));
  redis.on('connect', () => console.log('[redis] connected'));

  return redis;
}
