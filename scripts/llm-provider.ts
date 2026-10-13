// Shared LLM provider chain, used by scripts/llm-triage.ts (review-queue triage),
// scripts/llm-evals.ts (benchmark) and scripts/rumor-recheck.ts (rumor lifecycle). All need the same DeepSeek → MiMo →
// OpenRouter fallback wiring, so the client construction lives here once.
//
// Environment variables:
//   DEEPSEEK_API_KEY    DeepSeek key  (base URL: https://api.deepseek.com/v1)
//   DEEPSEEK_MODEL      model override (default: deepseek-v4-flash)
//   MIMO_API_KEY        MiMo key
//   MIMO_BASE_URL       MiMo OpenAI-compatible endpoint
//   MIMO_MODEL          model override (default: mimo-v2.5)
//   OPENROUTER_API_KEY  OpenRouter key (base URL: https://openrouter.ai/api/v1)
//   OPENROUTER_MODEL    model override (default: openrouter/owl-alpha)
//   LLM_PROVIDER        force a single provider: deepseek | mimo | openrouter

import OpenAI from 'openai';
import { sleep } from '../src/lib/async';

export interface ProviderConfig {
  name: string;
  client: OpenAI;
  model: string;
}

export type ChatClient = Pick<OpenAI, 'chat'>;

export interface ChatProvider {
  name: string;
  client: ChatClient;
  model: string;
}

export interface JsonCallOptions<T> {
  system: string;
  user: string;
  parse: (raw: string) => T | null;
  attempts?: number;
  log?: (message: string) => void;
}

export interface JsonCallResult<T> {
  value: T | null;
  provider: string;
  errors: string[];
}

// Per-request ceilings shared by every provider client. The OpenAI SDK defaults to a
// 10-minute timeout with 2 automatic retries, so a single hung request can silently
// burn ~30 min before falling through — enough to blow the whole job's 60-min cap.
// Bound both so one stuck request fails fast and the chain moves on. Override with
// LLM_TIMEOUT_MS / LLM_MAX_RETRIES if a slow reasoning model needs more headroom.
const REQUEST_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 120_000;
const REQUEST_MAX_RETRIES = Number.isFinite(Number(process.env.LLM_MAX_RETRIES))
  ? Number(process.env.LLM_MAX_RETRIES)
  : 1;

// Build the ordered provider chain from available env vars.
// If LLM_PROVIDER is set, only that provider is included (no fallback).
export function getProviderChain(): ProviderConfig[] {
  const force = process.env.LLM_PROVIDER;
  const chain: ProviderConfig[] = [];

  const want = (name: string) => !force || force === name;

  if (want('deepseek') && process.env.DEEPSEEK_API_KEY) {
    chain.push({
      name: 'deepseek',
      client: new OpenAI({
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseURL: 'https://api.deepseek.com/v1',
        timeout: REQUEST_TIMEOUT_MS,
        maxRetries: REQUEST_MAX_RETRIES,
      }),
      model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
    });
  }

  if (want('mimo') && process.env.MIMO_API_KEY && process.env.MIMO_BASE_URL) {
    chain.push({
      name: 'mimo',
      client: new OpenAI({
        apiKey: process.env.MIMO_API_KEY,
        baseURL: process.env.MIMO_BASE_URL,
        timeout: REQUEST_TIMEOUT_MS,
        maxRetries: REQUEST_MAX_RETRIES,
      }),
      model: process.env.MIMO_MODEL || 'mimo-v2.5',
    });
  }

  if (want('openrouter') && process.env.OPENROUTER_API_KEY) {
    chain.push({
      name: 'openrouter',
      client: new OpenAI({
        apiKey: process.env.OPENROUTER_API_KEY,
        baseURL: 'https://openrouter.ai/api/v1',
        timeout: REQUEST_TIMEOUT_MS,
        maxRetries: REQUEST_MAX_RETRIES,
        defaultHeaders: {
          'HTTP-Referer': 'https://github.com/luarss/sg-layoffz',
          'X-Title': 'sg-layoffz',
        },
      }),
      model: process.env.OPENROUTER_MODEL || 'openrouter/owl-alpha',
    });
  }

  if (chain.length === 0) {
    throw new Error(
      'No LLM provider configured. Set at least one of:\n' +
      '  DEEPSEEK_API_KEY\n' +
      '  MIMO_API_KEY + MIMO_BASE_URL\n' +
      '  OPENROUTER_API_KEY'
    );
  }

  return chain;
}

export function describeChain(chain: ChatProvider[]): string {
  return chain.map((p) => `${p.name}(${p.model})`).join(' → ');
}

const RETRY_BACKOFF_MS = 500;

type AttemptOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; notice: string | null };

async function attemptProvider<T>(
  provider: ChatProvider,
  options: JsonCallOptions<T>
): Promise<AttemptOutcome<T>> {
  try {
    const response = await provider.client.chat.completions.create({
      model: provider.model,
      messages: [
        { role: 'system', content: options.system },
        { role: 'user', content: options.user },
      ],
      temperature: 0,
      max_tokens: 4096,
      response_format: { type: 'json_object' },
    });
    const choice = response.choices[0];
    if (choice?.finish_reason === 'length') {
      return {
        ok: false,
        error: `${provider.name}: response truncated (finish_reason=length)`,
        notice: ` [${provider.name} truncated, trying next]`,
      };
    }
    const raw = choice?.message?.content || '{}';
    const value = options.parse(raw);
    if (value !== null) return { ok: true, value };
    return { ok: false, error: `${provider.name}: unparseable response (raw: ${raw.slice(0, 80)})`, notice: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `${provider.name}: ${message}`, notice: ` [${provider.name} failed, trying next]` };
  }
}

export async function callJsonWithChain<T>(
  chain: ChatProvider[],
  options: JsonCallOptions<T>
): Promise<JsonCallResult<T>> {
  const attempts = Math.max(1, options.attempts ?? 1);
  const log = options.log ?? ((message: string) => process.stdout.write(message));
  const errors: string[] = [];

  for (const provider of chain) {
    let notice: string | null = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const outcome = await attemptProvider(provider, options);
      if (outcome.ok) return { value: outcome.value, provider: provider.name, errors };
      errors.push(outcome.error);
      notice = outcome.notice;
      if (attempt < attempts) await sleep(RETRY_BACKOFF_MS * attempt);
    }
    if (notice) log(notice);
  }

  return { value: null, provider: 'none', errors };
}
