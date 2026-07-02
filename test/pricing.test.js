import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PRICING,
  loadPricing,
  priceFor,
  computeCost,
  estimateCost,
  roundUsd,
} from '../src/pricing.js';

test('computeCost applies gpt-4o-mini baseline rates exactly', () => {
  // Arrange: 1000 in / 1000 out at $0.0015 + $0.002
  // Act
  const cost = computeCost(DEFAULT_PRICING, 'gpt-4o-mini', 1000, 1000);
  // Assert
  assert.equal(cost, 0.0035);
});

test('computeCost falls back to DEFAULT tier for unknown models', () => {
  const cost = computeCost(DEFAULT_PRICING, 'some-future-model', 2000, 500);
  assert.equal(cost, (2000 / 1000) * 0.0015 + (500 / 1000) * 0.002);
});

test('computeCost returns zero for zero usage', () => {
  assert.equal(computeCost(DEFAULT_PRICING, 'gpt-4o-mini', 0, 0), 0);
});

test('roundUsd keeps 6dp and kills float noise', () => {
  assert.equal(roundUsd(0.1 + 0.2), 0.3);
  assert.equal(roundUsd(0.0000014), 0.000001);
});

test('loadPricing merges env JSON over defaults', () => {
  const pricing = loadPricing('{"my-model":{"input":1,"output":2}}');
  assert.deepEqual(priceFor(pricing, 'my-model'), { input: 1, output: 2 });
  // defaults still intact
  assert.deepEqual(priceFor(pricing, 'gpt-4o-mini'), DEFAULT_PRICING['gpt-4o-mini']);
});

test('loadPricing returns defaults when env JSON is invalid', () => {
  assert.equal(loadPricing('{not json'), DEFAULT_PRICING);
});

test('estimateCost uses max_tokens when provided', () => {
  const payload = {
    model: 'gpt-4o-mini',
    max_tokens: 100,
    messages: [{ role: 'user', content: 'x'.repeat(400) }], // ≈100 prompt tokens
  };
  const est = estimateCost(DEFAULT_PRICING, payload, 1024);
  assert.equal(est, computeCost(DEFAULT_PRICING, 'gpt-4o-mini', 100, 100));
});

test('estimateCost falls back to default completion estimate', () => {
  const payload = { messages: [{ role: 'user', content: 'hi' }] };
  const est = estimateCost(DEFAULT_PRICING, payload, 1024);
  assert.equal(est, computeCost(DEFAULT_PRICING, 'gpt-4o-mini', 1, 1024));
});

test('estimateCost handles structured (non-string) content', () => {
  const payload = {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  };
  // Should not throw, and should produce a positive estimate.
  assert.ok(estimateCost(DEFAULT_PRICING, payload, 10) > 0);
});
