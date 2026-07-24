// Shared LLM provider chain, used by scripts/llm-triage.ts (review-queue triage) and
// scripts/rumor-recheck.ts (rumor lifecycle). Both need the same DeepSeek → MiMo →
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

export interface ProviderConfig {
  name: string;
  client: OpenAI;
  model: string;
}

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
