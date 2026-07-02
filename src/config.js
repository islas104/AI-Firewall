/**
 * Centralized configuration. Everything is read once at boot from the
 * environment and frozen — no config mutation at runtime.
 */
import 'dotenv/config';
import { loadPricing } from './pricing.js';

const HOURS = 60 * 60;

export const config = Object.freeze({
  port: Number(process.env.PORT ?? 3000),

  // Budget
  hardDailyLimitUsd: Number(process.env.HARD_DAILY_LIMIT_USD ?? 10.0),

  // Infrastructure
  redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',

  // Upstream
  openaiApiKey: process.env.OPENAI_API_KEY ?? '',
  openaiBaseUrl: process.env.OPENAI_BASE_URL || undefined,
  // Mock mode fabricates deterministic completions locally — the full product
  // runs end-to-end (budgets, streaming, dashboard) with zero OpenAI spend.
  mockUpstream: process.env.MOCK_UPSTREAM === 'true',

  // Auth (both optional — set them in production)
  proxyApiKey: process.env.PROXY_API_KEY ?? '',
  adminApiKey: process.env.ADMIN_API_KEY ?? '',

  // Pricing table (USD per 1k tokens), extendable via MODEL_PRICING JSON.
  pricing: loadPricing(process.env.MODEL_PRICING),

  // Fallback completion-token estimate when the request has no max_tokens.
  defaultCompletionEstimate: Number(process.env.DEFAULT_COMPLETION_ESTIMATE ?? 1024),

  // Daily spend keys live 48h (covers timezone skew + lets dashboards read
  // yesterday). Pending reservations self-heal after 10 min if a process
  // crashes mid-flight and never commits.
  spentKeyTtlSeconds: 48 * HOURS,
  pendingKeyTtlSeconds: 600,
});

export function validateConfig() {
  if (!config.mockUpstream && !config.openaiApiKey) {
    throw new Error(
      'OPENAI_API_KEY is required (or set MOCK_UPSTREAM=true to run without an upstream).',
    );
  }
  if (!Number.isFinite(config.hardDailyLimitUsd) || config.hardDailyLimitUsd <= 0) {
    throw new Error('HARD_DAILY_LIMIT_USD must be a positive number.');
  }
}
