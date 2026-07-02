/**
 * Redis client factory with the two Lua commands that make budget enforcement
 * atomic. Lua scripts execute as a single unit inside Redis, so concurrent
 * requests can never race between "check the budget" and "reserve funds".
 */
import Redis from 'ioredis';

/**
 * reserveBudget(spentKey, pendingKey, limit, estimate, pendingTtl)
 *
 * Atomically:
 *  - HALT  if committed spend already ≥ limit (agent is done for the day)
 *  - DEFER if spend + in-flight reservations + this estimate would exceed the
 *          limit (remaining budget is reserved by concurrent requests)
 *  - OK    otherwise: reserve `estimate` in the pending counter
 *
 * Returns { status, spent, pending } (numbers stringified by Redis).
 */
const RESERVE_LUA = `
local spent = tonumber(redis.call('GET', KEYS[1]) or '0')
local pending = tonumber(redis.call('GET', KEYS[2]) or '0')
local limit = tonumber(ARGV[1])
local estimate = tonumber(ARGV[2])
if spent >= limit then
  return {'halt', tostring(spent), tostring(pending)}
end
if spent + pending + estimate > limit then
  return {'defer', tostring(spent), tostring(pending)}
end
redis.call('INCRBYFLOAT', KEYS[2], ARGV[2])
redis.call('EXPIRE', KEYS[2], ARGV[3])
return {'ok', tostring(spent), tostring(pending + estimate)}
`;

/**
 * commitSpend(spentKey, pendingKey, actualCost, reservedEstimate, spentTtl)
 *
 * Atomically release the reservation and record the actual cost. Called with
 * actualCost = 0 to release a reservation after an upstream failure.
 * Returns the new committed total.
 */
const COMMIT_LUA = `
local spent = redis.call('INCRBYFLOAT', KEYS[1], ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[3])
local pending = tonumber(redis.call('INCRBYFLOAT', KEYS[2], '-' .. ARGV[2]))
if pending <= 0 then redis.call('DEL', KEYS[2]) end
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

  redis.defineCommand('reserveBudget', { numberOfKeys: 2, lua: RESERVE_LUA });
  redis.defineCommand('commitSpend', { numberOfKeys: 2, lua: COMMIT_LUA });

  redis.on('error', (err) => console.error('[redis] connection error:', err.message));
  redis.on('connect', () => console.log('[redis] connected'));

  return redis;
}
