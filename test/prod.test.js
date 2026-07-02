/**
 * Production-hardening tests: security headers, agent-id validation,
 * per-agent rate limiting, and the Prometheus metrics endpoint.
 * Skipped cleanly when Redis is unavailable (same contract as integration).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRedis } from '../src/redis.js';
import { createBudgetStore } from '../src/budget.js';
import { createMockUpstream } from '../src/upstream.js';
import { createApp } from '../src/app.js';
import { loadPricing } from '../src/pricing.js';

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/14';
const RUN = `p${process.pid}`;

const baseConfig = {
  hardDailyLimitUsd: 100,
  pricing: loadPricing(),
  defaultCompletionEstimate: 10,
  spentKeyTtlSeconds: 300,
  pendingKeyTtlSeconds: 60,
  proxyApiKey: '',
  adminApiKey: '',
  mockUpstream: true,
  rateLimitRpm: 0,
  logLevel: 'silent',
  enableHsts: false,
};

const CHAT = { model: 'gpt-4o-mini', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] };

let redis, redisUp = true;
const servers = [];

function boot(configOverrides = {}) {
  const config = { ...baseConfig, ...configOverrides };
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

test('security headers present on every response', async (t) => {
  if (skipIfNoRedis(t)) return;
  const base = boot();
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(res.headers.get('x-powered-by'), null);
  // HSTS off by default (only meaningful behind TLS)
  assert.equal(res.headers.get('strict-transport-security'), null);
});

test('invalid agent ids are rejected before touching Redis keys', async (t) => {
  if (skipIfNoRedis(t)) return;
  const base = boot();
  // Note: newline injection can't be tested via fetch — undici rejects such
  // headers client-side. The server regex still blocks it (defense-in-depth
  // for clients with laxer HTTP stacks).
  for (const bad of ['has space', 'colon:injection', 'a'.repeat(65), '-startdash', 'semi;colon']) {
    const res = await post(base, CHAT, { 'X-Agent-ID': bad });
    assert.equal(res.status, 400, `expected 400 for agent id ${JSON.stringify(bad)}`);
    const body = await res.json();
    assert.equal(body.error.type, 'invalid_agent_id');
  }
  // A valid one still works
  const ok = await post(base, CHAT, { 'X-Agent-ID': `${RUN}-valid.agent_01` });
  assert.equal(ok.status, 200);
});

test('per-agent rate limit trips within the minute window', async (t) => {
  if (skipIfNoRedis(t)) return;
  const base = boot({ rateLimitRpm: 2 });
  const id = `${RUN}-ratelimited`;
  const results = [];
  for (let i = 0; i < 5; i++) {
    results.push((await post(base, CHAT, { 'X-Agent-ID': id })).status);
  }
  // 5 sequential requests against a 2/min limit must produce at least one 429
  // regardless of where the minute boundary falls.
  assert.ok(results.includes(429), `expected a 429 in ${JSON.stringify(results)}`);
  const limited = await post(base, CHAT, { 'X-Agent-ID': id });
  if (limited.status === 429) {
    const body = await limited.json();
    assert.equal(body.error.type, 'rate_limited');
    assert.ok(limited.headers.get('retry-after'));
  }
});

test('rate limiting is isolated per agent', async (t) => {
  if (skipIfNoRedis(t)) return;
  const base = boot({ rateLimitRpm: 2 });
  // Exhaust agent A
  for (let i = 0; i < 4; i++) await post(base, CHAT, { 'X-Agent-ID': `${RUN}-hog` });
  // Agent B is unaffected
  const res = await post(base, CHAT, { 'X-Agent-ID': `${RUN}-bystander` });
  assert.equal(res.status, 200);
});

test('/metrics exposes Prometheus counters', async (t) => {
  if (skipIfNoRedis(t)) return;
  const base = boot();
  await post(base, CHAT, { 'X-Agent-ID': `${RUN}-metrics` });
  const res = await fetch(`${base}/metrics`);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /http_requests_total/);
  assert.match(text, /agent_spend_usd_total/);
  assert.match(text, /route="\/v1\/chat\/completions"/);
});

test('/metrics is protected when ADMIN_API_KEY is set', async (t) => {
  if (skipIfNoRedis(t)) return;
  const base = boot({ adminApiKey: 'metrics-secret' });
  assert.equal((await fetch(`${base}/metrics`)).status, 401);
  const authed = await fetch(`${base}/metrics`, { headers: { 'X-Admin-Key': 'metrics-secret' } });
  assert.equal(authed.status, 200);
});

test('oversized body → 413, not a crash', async (t) => {
  if (skipIfNoRedis(t)) return;
  const base = boot();
  const res = await post(base, { ...CHAT, messages: [{ role: 'user', content: 'x'.repeat(3 * 1024 * 1024) }] }, { 'X-Agent-ID': `${RUN}-big` });
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error.type, 'payload_too_large');
});
