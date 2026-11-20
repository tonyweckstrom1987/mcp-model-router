import type { UsageConfig } from "../config/schema.js";
import { authHeaders, joinUrl, redactSecret } from "../lib/openaiClient.js";

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

/**
 * LiteLLM:n /user/info palauttaa myos avainten metatietoja (keys[]: token-tiiviste,
 * key_name, key_alias, user_id, team_id, metadata) ja tiimit. get_usage ei valita
 * niita: raw-kenttaan paasee vain kulutus- ja budjettikentat.
 */
export const LITELLM_RAW_ALLOWED_FIELDS = ["spend", "max_budget", "budget_duration", "budget_reset_at"] as const;

export function pickAllowedFields(source: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof source !== "object" || source === null) return out;
  const rec = source as Record<string, unknown>;
  for (const key of LITELLM_RAW_ALLOWED_FIELDS) {
    if (key in rec) out[key] = rec[key];
  }
  return out;
}

export const USAGE_TIMEOUT_MS = 15_000;

/** fetch aikakatkaisulla: sekä yhteys että vastausrungon luku keskeytetään. */
async function getJson(url: string, config: UsageConfig, nimi: string): Promise<unknown> {
  const ms = config.timeoutMs ?? USAGE_TIMEOUT_MS;
  try {
    const res = await fetch(url, { headers: authHeaders(config.apiKey), signal: AbortSignal.timeout(ms) });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`fetching ${nimi} usage data failed (${res.status} ${res.statusText}): ${redactSecret(body, config.apiKey).slice(0, 300)}`);
    }
    return await res.json();
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new Error(`${nimi}-kulutustietojen haku aikakatkaistiin (${ms} ms)`);
    }
    throw err;
  }
}

/** A JSON `null`, number, string or array would crash property access later; fail with a clear message instead. */
function requireObject(json: unknown, nimi: string): Record<string, unknown> {
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    throw new Error(`${nimi} returned an unexpected response: expected a JSON object`);
  }
  return json as Record<string, unknown>;
}

export async function fetchUsage(config: UsageConfig): Promise<UsageSnapshot> {
  if (config.provider === "openrouter") return fetchOpenRouterUsage(config);
  return fetchLiteLlmUsage(config);
}

async function fetchLiteLlmUsage(config: UsageConfig): Promise<UsageSnapshot> {
  const url = joinUrl(config.baseUrl, "/user/info");
  const json = requireObject(await getJson(url, config, "LiteLLM"), "LiteLLM") as {
    user_info?: { spend?: number; max_budget?: number | null };
    spend?: number;
    max_budget?: number | null;
  };
  // Older LiteLLM versions return spend and max_budget at the top level, and
  // some responses carry user_info without them. Fields in user_info win;
  // the top level fills in what user_info lacks.
  const info = { ...pickAllowedFields(json), ...pickAllowedFields(json.user_info) } as {
    spend?: number;
    max_budget?: number | null;
  };
  const spend = typeof info.spend === "number" ? info.spend : null;
  const budget = typeof info.max_budget === "number" ? info.max_budget : null;
  return {
    provider: "litellm",
    raw: { user_info: pickAllowedFields(info) },
    summary: {
      spendUsd: spend,
      budgetUsd: budget,
      remainingUsd: spend !== null && budget !== null ? budget - spend : null,
    },
  };
}

async function fetchOpenRouterUsage(config: UsageConfig): Promise<UsageSnapshot> {
  const url = joinUrl(config.baseUrl, "/credits");
  const json = requireObject(await getJson(url, config, "OpenRouter"), "OpenRouter") as {
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
