import type { UsageConfig } from "../config/schema.js";
import { authHeaders, joinUrl } from "../lib/openaiClient.js";

/**
 * Lukee kulutuksen ja budjetin tilan LiteLLM:n tai OpenRouterin omista
 * rajapinnoista - ei omaa kirjanpitoa kulutukselle.
 */
export interface UsageSummary {
  spendUsd: number | null;
  budgetUsd: number | null;
  remainingUsd: number | null;
}

export interface UsageSnapshot {
  provider: "litellm" | "openrouter";
  summary: UsageSummary;
  raw: unknown;
}

export async function fetchUsage(config: UsageConfig): Promise<UsageSnapshot> {
  if (config.provider === "openrouter") return fetchOpenRouterUsage(config);
  return fetchLiteLlmUsage(config);
}

async function fetchLiteLlmUsage(config: UsageConfig): Promise<UsageSnapshot> {
  const url = joinUrl(config.baseUrl, "/user/info");
  const res = await fetch(url, { headers: authHeaders(config.apiKey) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LiteLLM-kulutustietojen haku epäonnistui (${res.status} ${res.statusText}): ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    user_info?: { spend?: number; max_budget?: number | null };
    spend?: number;
    max_budget?: number | null;
  };
  const info = json.user_info ?? json;
  const spend = typeof info.spend === "number" ? info.spend : null;
  const budget = typeof info.max_budget === "number" ? info.max_budget : null;
  return {
    provider: "litellm",
    raw: json,
    summary: {
      spendUsd: spend,
      budgetUsd: budget,
      remainingUsd: spend !== null && budget !== null ? budget - spend : null,
    },
  };
}

async function fetchOpenRouterUsage(config: UsageConfig): Promise<UsageSnapshot> {
  const url = joinUrl(config.baseUrl, "/credits");
  const res = await fetch(url, { headers: authHeaders(config.apiKey) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenRouter-kulutustietojen haku epäonnistui (${res.status} ${res.statusText}): ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    data?: { total_credits?: number; total_usage?: number };
  };
  const data = json.data ?? {};
  const totalCredits = typeof data.total_credits === "number" ? data.total_credits : null;
  const totalUsage = typeof data.total_usage === "number" ? data.total_usage : null;
  return {
    provider: "openrouter",
    raw: json,
    summary: {
      spendUsd: totalUsage,
      budgetUsd: totalCredits,
      remainingUsd: totalCredits !== null && totalUsage !== null ? totalCredits - totalUsage : null,
    },
  };
}
