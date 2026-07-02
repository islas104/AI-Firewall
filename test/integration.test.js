/**
 * Full-stack integration tests: real Express app + real Redis + mock upstream.
 * Requires a reachable Redis (TEST_REDIS_URL or redis://127.0.0.1:6379);
 * the whole suite is skipped cleanly when Redis is down.
 *
 * Uses DB 15 and a unique agent prefix per run so it never collides with dev data.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRedis } from '../src/redis.js';
import { createBudgetStore } from '../src/budget.js';
import { createMockUpstream } from '../src/upstream.js';
import { createApp } from '../src/app.js';
import { loadPricing } from '../src/pricing.js';

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/15';
const RUN = `t${process.pid}`;
const agent = (name) => `${RUN}-${name}`;

const config = {
  hardDailyLimitUsd: 1.0,
  pricing: loadPricing(),
  defaultCompletionEstimate: 100,
  spentKeyTtlSeconds: 300,
  pendingKeyTtlSeconds: 60,
  proxyApiKey: '',
  adminApiKey: '',
  mockUpstream: true,
};

let redis, server, base, redisUp = true;

before(async () => {
  redis = createRedis(REDIS_URL);
  try {
    await redis.ping();
  } catch {
    redisUp = false;
    redis.disconnect();
    return;
  }
  await redis.flushdb();
  const budget = createBudgetStore(redis, config);
  const app = createApp({ config, redis, budget, upstream: createMockUpstream() });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  if (redisUp) await redis.quit();
});

const skipIfNoRedis = (t) => {
  if (!redisUp) { t.skip('Redis unavailable — start it with: docker compose up -d redis'); return true; }
  return false;
};

function post(path, body, headers = {}) {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const CHAT = { model: 'gpt-4o-mini', max_tokens: 50, messages: [{ role: 'user', content: 'hello' }] };

test('rejects request without X-Agent-ID (400)', async (t) => {
  if (skipIfNoRedis(t)) return;
  const res = await post('/v1/chat/completions', CHAT);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.type, 'missing_agent_id');
});

test('rejects empty messages (400)', async (t) => {
  if (skipIfNoRedis(t)) return;
  const res = await post('/v1/chat/completions', { model: 'gpt-4o-mini', messages: [] }, { 'X-Agent-ID': agent('a') });
  assert.equal(res.status, 400);
});

test('proxies a completion and meters cost in headers + Redis', async (t) => {
  if (skipIfNoRedis(t)) return;
  const id = agent('meter');
  const res = await post('/v1/chat/completions', CHAT, { 'X-Agent-ID': id });
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.ok(body.choices[0].message.content.length > 0);
  assert.ok(body.usage.prompt_tokens > 0);

  const cost = Number(res.headers.get('x-budget-cost-usd'));
  assert.ok(cost > 0, 'cost header present and positive');

  const status = await (await fetch(`${base}/v1/budget/${id}`)).json();
  assert.equal(status.spentUsd, cost);
  assert.equal(status.pendingUsd, 0, 'reservation fully released');
  assert.equal(status.exceeded, false);
});

test('kill-switch: 402 with exact body once limit is exceeded', async (t) => {
  if (skipIfNoRedis(t)) return;
  const id = agent('runaway');
  // Trip the switch by writing spend directly (same shape the proxy writes).
  const day = new Date().toISOString().slice(0, 10);
  await redis.set(`agent:budget:spent:${id}:${day}`, '5.0');

  const res = await post('/v1/chat/completions', CHAT, { 'X-Agent-ID': id });
  assert.equal(res.status, 402);
  assert.deepEqual(await res.json(), { error: 'Budget exceeded. Agent execution halted.' });
});

test('reservation blocks a single request that could overshoot (429)', async (t) => {
  if (skipIfNoRedis(t)) return;
  const id = agent('big');
  // limit $1; ask for a completion whose worst case (500k tokens out) >> $1
  const res = await post(
    '/v1/chat/completions',
    { ...CHAT, max_tokens: 500000 },
    { 'X-Agent-ID': id },
  );
  assert.equal(res.status, 429);
  const body = await res.json();
  assert.equal(body.error.type, 'budget_contention');
});

test('concurrent burst can never overshoot the ceiling', async (t) => {
  if (skipIfNoRedis(t)) return;
  const id = agent('burst');
  // Each call reserves ~ (1 prompt + 50000 completion tokens) ≈ $0.10.
  // Limit is $1.00 → at most ~10 of 40 can be admitted, never more than limit.
  const burst = Array.from({ length: 40 }, () =>
    post('/v1/chat/completions', { ...CHAT, max_tokens: 50000 }, { 'X-Agent-ID': id }),
  );
  const results = await Promise.all(burst);
  const okCount = results.filter((r) => r.status === 200).length;
  const blocked = results.filter((r) => r.status === 429 || r.status === 402).length;
  assert.equal(okCount + blocked, 40);
  assert.ok(okCount >= 1, 'some requests admitted');

  const status = await (await fetch(`${base}/v1/budget/${id}`)).json();
  assert.ok(
    status.spentUsd <= 1.0 + 1e-9,
    `committed spend ($${status.spentUsd}) must never exceed the $1 ceiling`,
  );
});

test('streaming: SSE chunks flow and usage is metered at stream end', async (t) => {
  if (skipIfNoRedis(t)) return;
  const id = agent('stream');
  const res = await post('/v1/chat/completions', { ...CHAT, stream: true }, { 'X-Agent-ID': id });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);

  const text = await res.text();
  assert.ok(text.includes('data: '), 'SSE frames present');
  assert.ok(text.trimEnd().endsWith('data: [DONE]'), 'stream terminates with [DONE]');
  assert.ok(text.includes('"usage"'), 'usage chunk forwarded');

  // Metering is committed in the same tick as res.end(); poll briefly.
  let status;
  for (let i = 0; i < 20; i++) {
    status = await (await fetch(`${base}/v1/budget/${id}`)).json();
    if (status.spentUsd > 0) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(status.spentUsd > 0, 'streamed call was metered');
  assert.equal(status.pendingUsd, 0, 'reservation fully released');
});

test('admin: per-agent limit override and spend reset', async (t) => {
  if (skipIfNoRedis(t)) return;
  const id = agent('vip');

  // Raise this agent's limit to $50
  let res = await fetch(`${base}/admin/agents/${id}/limit`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limitUsd: 50 }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).limitUsd, 50);

  // Spend something, then reset it
  await post('/v1/chat/completions', CHAT, { 'X-Agent-ID': id });
  res = await fetch(`${base}/admin/agents/${id}/spend`, { method: 'DELETE' });
  const after = await res.json();
  assert.equal(after.spentUsd, 0);

  // Clear the override → back to global limit
  res = await fetch(`${base}/admin/agents/${id}/limit`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limitUsd: null }),
  });
  assert.equal((await res.json()).limitUsd, config.hardDailyLimitUsd);
});

test('admin: fleet listing includes agents seen today', async (t) => {
  if (skipIfNoRedis(t)) return;
  const id = agent('fleet');
  await post('/v1/chat/completions', CHAT, { 'X-Agent-ID': id });
  const data = await (await fetch(`${base}/admin/agents`)).json();
  assert.ok(data.agents.some((a) => a.agentId === id));
  assert.equal(data.upstream, 'mock');
});

test('auth: proxy key enforced when configured', async (t) => {
  if (skipIfNoRedis(t)) return;
  // Assemble a second app instance with keys enabled.
  const secured = createApp({
    config: { ...config, proxyApiKey: 'sk-proxy', adminApiKey: 'admin-secret' },
    redis,
    budget: createBudgetStore(redis, config),
    upstream: createMockUpstream(),
  });
  const s = secured.listen(0);
  const sBase = `http://127.0.0.1:${s.address().port}`;
  try {
    const noKey = await fetch(`${sBase}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-ID': agent('x') },
      body: JSON.stringify(CHAT),
    });
    assert.equal(noKey.status, 401);

    const withKey = await fetch(`${sBase}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-ID': agent('x'),
        Authorization: 'Bearer sk-proxy',
      },
      body: JSON.stringify(CHAT),
    });
    assert.equal(withKey.status, 200);

    const adminNoKey = await fetch(`${sBase}/admin/agents`);
    assert.equal(adminNoKey.status, 401);
  } finally {
    s.close();
  }
});

test('malformed JSON body → clean 400, not a crash', async (t) => {
  if (skipIfNoRedis(t)) return;
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-ID': agent('bad') },
    body: '{oops',
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.type, 'invalid_json');
});
