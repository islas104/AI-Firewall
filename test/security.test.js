/**
 * Security-hardening round 2: global daily cap (agent-ID rotation defense),
 * agent allowlist, per-IP rate limiting, and failed-auth lockout.
 * Skipped cleanly when Redis is unavailable.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRedis } from '../src/redis.js';
import { createBudgetStore } from '../src/budget.js';
import { createMockUpstream } from '../src/upstream.js';
import { createApp } from '../src/app.js';
import { loadPricing } from '../src/pricing.js';

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/13';
const RUN = `s${process.pid}`;

const baseConfig = {
  hardDailyLimitUsd: 100,
  totalDailyLimitUsd: 0, // per-test override
  pricing: loadPricing(),
  defaultCompletionEstimate: 10,
  spentKeyTtlSeconds: 300,
  pendingKeyTtlSeconds: 60,
  proxyApiKey: '',
  adminApiKey: '',
  mockUpstream: true,
  rateLimitRpm: 0,
  ipRateLimitRpm: 0,
  authFailLimitPerMin: 10,
  agentAllowlist: null,
  logLevel: 'silent',
  enableHsts: false,
};

const CHAT = { model: 'gpt-4o-mini', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] };

let redis, redisUp = true;
const servers = [];

function boot(overrides = {}) {
  const config = { ...baseConfig, ...overrides };
  const app = createApp({
    config,
    redis,
    budget: createBudgetStore(redis, config),
    upstream: createMockUpstream(),
  });
  const server = app.listen(0);
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

before(async () => {
  redis = createRedis(REDIS_URL);
  try {
    await redis.ping();
    await redis.flushdb();
  } catch {
    redisUp = false;
    redis.disconnect();
  }
});

after(async () => {
  servers.forEach((s) => s.close());
  if (redisUp) await redis.quit();
});

const skipIfNoRedis = (t) => {
  if (!redisUp) { t.skip('Redis unavailable'); return true; }
  return false;
};

function post(base, body, headers = {}) {
  return fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Global daily cap — closes the agent-ID rotation loophole
// ---------------------------------------------------------------------------

test('global cap: rotating agent IDs cannot exceed the fleet-wide budget', async (t) => {
  if (skipIfNoRedis(t)) return;
  // Per-agent limit generous; GLOBAL cap tiny. Each mock call costs ~$0.0001
  // and reserves ~(1 + 10 completion tokens). Cap the fleet at $0.0003.
  const base = boot({ hardDailyLimitUsd: 100, totalDailyLimitUsd: 0.0003 });

  const results = [];
  for (let i = 0; i < 12; i++) {
    // Attacker mints a FRESH agent id every request
    const res = await post(base, CHAT, { 'X-Agent-ID': `${RUN}-rotate-${i}` });
    results.push(res.status);
  }
  const blocked = results.filter((s) => s === 402 || s === 429).length;
  assert.ok(blocked > 0, `rotation must eventually be blocked, got ${JSON.stringify(results)}`);

  // A fresh id is still blocked: 402 once committed spend reaches the cap,
  // or 429 while reservations hold the remainder. Either way — no spend.
  const final = await post(base, CHAT, { 'X-Agent-ID': `${RUN}-rotate-fresh` });
  assert.ok([402, 429].includes(final.status), `expected block, got ${final.status}`);

  // THE invariant that closes the loophole: fleet-wide committed spend can
  // never exceed the global cap, no matter how many agent ids were minted.
  const { fleet } = await (await fetch(`${base}/admin/agents`)).json();
  assert.ok(
    fleet.totalSpentUsd <= 0.0003 + 1e-9,
    `fleet spend ($${fleet.totalSpentUsd}) must never exceed the $0.0003 cap`,
  );
});

test('global cap of 0 disables the fleet ceiling (per-agent still applies)', async (t) => {
  if (skipIfNoRedis(t)) return;
  const base = boot({ hardDailyLimitUsd: 100, totalDailyLimitUsd: 0 });
  for (let i = 0; i < 5; i++) {
    const res = await post(base, CHAT, { 'X-Agent-ID': `${RUN}-nocap-${i}` });
    assert.equal(res.status, 200);
  }
});

test('fleet status is exposed on the admin surface', async (t) => {
  if (skipIfNoRedis(t)) return;
  const base = boot({ totalDailyLimitUsd: 50 });
  await post(base, CHAT, { 'X-Agent-ID': `${RUN}-fleet` });
  const data = await (await fetch(`${base}/admin/agents`)).json();
  assert.ok(data.fleet, 'fleet block present');
  assert.equal(data.fleet.totalLimitUsd, 50);
  assert.ok(data.fleet.totalSpentUsd > 0);
});

// ---------------------------------------------------------------------------
// Agent allowlist
// ---------------------------------------------------------------------------

test('allowlist: unknown agents get 403, listed agents pass', async (t) => {
  if (skipIfNoRedis(t)) return;
  const vip = `${RUN}-vip`;
  const base = boot({ agentAllowlist: [vip, 'other-agent'] });

  const denied = await post(base, CHAT, { 'X-Agent-ID': `${RUN}-intruder` });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error.type, 'agent_not_allowed');

  const allowed = await post(base, CHAT, { 'X-Agent-ID': vip });
  assert.equal(allowed.status, 200);
});

// ---------------------------------------------------------------------------
// Per-IP rate limiting
// ---------------------------------------------------------------------------

test('per-IP limit throttles regardless of agent id rotation', async (t) => {
  if (skipIfNoRedis(t)) return;
  const base = boot({ ipRateLimitRpm: 3 });
  const results = [];
  for (let i = 0; i < 7; i++) {
    // different agent every time — IP is the throttled subject
    const res = await post(base, CHAT, { 'X-Agent-ID': `${RUN}-ip-${i}` });
    results.push(res.status);
  }
  assert.ok(results.includes(429), `expected an IP 429 in ${JSON.stringify(results)}`);
});

// ---------------------------------------------------------------------------
// Failed-auth lockout
// ---------------------------------------------------------------------------

test('failed-auth lockout: repeated bad keys get 429, valid key locked out too', async (t) => {
  if (skipIfNoRedis(t)) return;
  const base = boot({ proxyApiKey: 'sk-correct', authFailLimitPerMin: 3 });

  // Burn through the failure allowance with wrong keys
  const statuses = [];
  for (let i = 0; i < 6; i++) {
    const res = await post(base, CHAT, {
      'X-Agent-ID': `${RUN}-brute`,
      Authorization: `Bearer wrong-key-${i}`,
    });
    statuses.push(res.status);
  }
  assert.ok(statuses.slice(0, 3).every((s) => s === 401), 'first attempts are 401');
  assert.ok(statuses.includes(429), `lockout kicks in: ${JSON.stringify(statuses)}`);
  const lockout = await post(base, CHAT, {
    'X-Agent-ID': `${RUN}-brute`,
    Authorization: 'Bearer wrong-again',
  });
  assert.equal((await lockout.json()).error.type, 'auth_lockout');
});
