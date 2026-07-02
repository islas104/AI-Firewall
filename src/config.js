/**
 * Centralized configuration. Everything is read once at boot from the
 * environment and frozen — no config mutation at runtime.
 */
import 'dotenv/config';
import { loadPricing } from './pricing.js';

const HOURS = 60 * 60;

export const config = Object.freeze({
  port: Number(process.env.PORT ?? 3000),

  // Budget (per agent, UTC calendar day)
  hardDailyLimitUsd: Number(process.env.HARD_DAILY_LIMIT_USD ?? 10),

  // Fleet-wide daily ceiling across ALL agents. Closes the agent-ID rotation
  // loophole: without it, a leaked proxy key could mint fresh agent IDs, each
  // with a fresh per-agent budget. Defaults to 2x the per-agent limit.
  // Set to 0 to disable (per-agent limits still apply).
  totalDailyLimitUsd: Number(
    process.env.TOTAL_DAILY_LIMIT_USD ?? 2 * Number(process.env.HARD_DAILY_LIMIT_USD ?? 10),
  ),

  // Optional closed set of permitted agent IDs (comma-separated). When set,
  // unknown agents get 403 before touching any budget.
  agentAllowlist: process.env.AGENT_ALLOWLIST
    ? process.env.AGENT_ALLOWLIST.split(',').map((s) => s.trim()).filter(Boolean)
    : null,

  // Request rate limiting (requests/minute; 0 disables)
  rateLimitRpm: Number(process.env.RATE_LIMIT_RPM ?? 60), // per agent
  ipRateLimitRpm: Number(process.env.IP_RATE_LIMIT_RPM ?? 120), // per client IP

  // Failed-auth attempts allowed per IP per minute before 429 lockout.
  authFailLimitPerMin: Number(process.env.AUTH_FAIL_LIMIT_PER_MIN ?? 10),

  // Infrastructure
  redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',

  // Upstream
  openaiApiKey: process.env.OPENAI_API_KEY ?? '',
  openaiBaseUrl: process.env.OPENAI_BASE_URL || undefined,
  upstreamTimeoutMs: Number(process.env.UPSTREAM_TIMEOUT_MS ?? 60_000),
  upstreamMaxRetries: Number(process.env.UPSTREAM_MAX_RETRIES ?? 1),
  // Mock mode fabricates deterministic completions locally — the full product
  // runs end-to-end (budgets, streaming, dashboard) with zero OpenAI spend.
  mockUpstream: process.env.MOCK_UPSTREAM === 'true',

  // Auth (both optional — set them in production)
  proxyApiKey: process.env.PROXY_API_KEY ?? '',
  adminApiKey: process.env.ADMIN_API_KEY ?? '',

  // Ops
  logLevel: process.env.LOG_LEVEL ?? 'info',
  // Set when running behind a load balancer / reverse proxy so client IPs
  // and protocol are read from X-Forwarded-* ("1" = one trusted hop).
  trustProxy: process.env.TRUST_PROXY === 'true' ? 1 : Number(process.env.TRUST_PROXY ?? 0),
  // Only enable when TLS terminates in front of the proxy.
  enableHsts: process.env.ENABLE_HSTS === 'true',

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
  const problems = [];
  if (!config.mockUpstream && !config.openaiApiKey) {
    problems.push('OPENAI_API_KEY is required (or set MOCK_UPSTREAM=true to run without an upstream).');
  }
  if (!Number.isFinite(config.hardDailyLimitUsd) || config.hardDailyLimitUsd <= 0) {
    problems.push('HARD_DAILY_LIMIT_USD must be a positive number.');
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    problems.push('PORT must be an integer between 1 and 65535.');
  }
  if (!Number.isFinite(config.rateLimitRpm) || config.rateLimitRpm < 0) {
    problems.push('RATE_LIMIT_RPM must be zero (disabled) or a positive number.');
  }
  if (!Number.isFinite(config.ipRateLimitRpm) || config.ipRateLimitRpm < 0) {
    problems.push('IP_RATE_LIMIT_RPM must be zero (disabled) or a positive number.');
  }
  if (!Number.isFinite(config.totalDailyLimitUsd) || config.totalDailyLimitUsd < 0) {
    problems.push('TOTAL_DAILY_LIMIT_USD must be zero (disabled) or a positive number.');
  }
  if (config.totalDailyLimitUsd > 0 && config.totalDailyLimitUsd < config.hardDailyLimitUsd) {
    problems.push('TOTAL_DAILY_LIMIT_USD must be >= HARD_DAILY_LIMIT_USD (or 0 to disable).');
  }
  if (!Number.isFinite(config.upstreamTimeoutMs) || config.upstreamTimeoutMs <= 0) {
    problems.push('UPSTREAM_TIMEOUT_MS must be a positive number of milliseconds.');
  }
  if (problems.length) {
    throw new Error(problems.join(' '));
  }
}
