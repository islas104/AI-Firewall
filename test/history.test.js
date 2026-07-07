/**
 * Spend-history persistence + export, and the security-LOW fixes from the
 * post-pentest hardening (healthz disclosure, rate-limit header leak).
 * Skipped cleanly when Redis is unavailable.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRedis } from '../src/redis.js';
import { createBudgetStore } from '../src/budget.js';
import { createMockUpstream } from '../src/upstream.js';
import { createApp } from '../src/app.js';
import { loadPricing } from '../src/pricing.js';

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/11';
const RUN = `h${process.pid}`;

const config = {
  hardDailyLimitUsd: 5,
  totalDailyLimitUsd: 10,
  pricing: loadPricing(),
  defaultCompletionEstimate: 4096,
  maxTokensCeiling: 32000,
  rejectUnknownModels: true,
  spentKeyTtlSeconds: 300,
  pendingKeyTtlSeconds: 60,
  historyRetentionDays: 90,
  proxyApiKey: '',
  adminApiKey: '',
  mockUpstream: true,
  rateLimitRpm: 0,
  ipRateLimitRpm: 1000, // enabled (so the no-header test is valid) but won't trip

  authFailLimitPerMin: 10,
  agentAllowlist: null,
  logLevel: 'silent',
  enableHsts: false,
};

let redis,
  server,
  base,
  budget,
  redisUp = true;

before(async () => {
  redis = createRedis(REDIS_URL);
  try {
    await redis.ping();
    await redis.flushdb();
  } catch {
    redisUp = false;
    redis.disconnect();
    return;
  }
  budget = createBudgetStore(redis, config);
  server = createApp({ config, redis, budget, upstream: createMockUpstream() }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  if (redisUp) await redis.quit();
});

const skip = (t) => {
  if (!redisUp) {
    t.skip('Redis unavailable');
    return true;
  }
  return false;
};
const post = (body, headers = {}) =>
  fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
const CHAT = { model: 'gpt-4o-mini', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] };

test('spend history records committed spend and survives as export data', async (t) => {
  if (skip(t)) return;
  const id = `${RUN}-hist`;
  await post(CHAT, { 'X-Agent-ID': id });
  await post(CHAT, { 'X-Agent-ID': id });

  const hist = await budget.getHistory(30);
  const row = hist.agents.find((a) => a.agentId === id);
  assert.ok(row, 'agent appears in history');
  assert.ok(row.total > 0, 'history total is positive');
  const today = new Date().toISOString().slice(0, 10);
  assert.ok(row.byDay[today] > 0, "today's spend is recorded");
});

test('GET /admin/history returns JSON with a generatedAt stamp', async (t) => {
  if (skip(t)) return;
  await post(CHAT, { 'X-Agent-ID': `${RUN}-json` });
  const res = await fetch(`${base}/admin/history?days=7`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.generatedAt, 'has generatedAt');
  assert.ok(Array.isArray(body.agents));
  assert.equal(body.days.length, 7);
});

test('GET /admin/history.csv returns well-formed CSV', async (t) => {
  if (skip(t)) return;
  await post(CHAT, { 'X-Agent-ID': `${RUN}-csv` });
  const res = await fetch(`${base}/admin/history.csv`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  const text = await res.text();
  assert.match(text.split('\n')[0], /^agentId,date,spentUsd$/);
  assert.match(text, new RegExp(`${RUN}-csv,\\d{4}-\\d{2}-\\d{2},`));
});

test('rejected reservations do not appear in history (only real spend)', async (t) => {
  if (skip(t)) return;
  const id = `${RUN}-halted`;
  const day = new Date().toISOString().slice(0, 10);
  await redis.set(`agent:budget:spent:${id}:${day}`, '99');
  await post(CHAT, { 'X-Agent-ID': id }); // 402, no spend
  const hist = await budget.getHistory(30);
  assert.ok(!hist.agents.some((a) => a.agentId === id), 'halted agent has no history row');
});

test('security LOW: /healthz discloses no config', async (t) => {
  if (skip(t)) return;
  const body = await (await fetch(`${base}/healthz`)).json();
  assert.deepEqual(Object.keys(body), ['status']);
  assert.equal(body.status, 'ok');
});

test('security LOW: pre-auth per-IP limiter does not leak rate-limit headers', async (t) => {
  if (skip(t)) return;
  // No auth configured here, but the IP limiter still runs globally. Its
  // headers must NOT be emitted (they used to advertise the threshold on 401s).
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.headers.get('x-ratelimit-limit'), null);
});
