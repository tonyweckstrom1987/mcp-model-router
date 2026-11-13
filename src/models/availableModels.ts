import type { ProviderConfig } from "../config/schema.js";
import { authHeaders, joinUrl } from "../lib/openaiClient.js";

/**
 * Hakee palvelimen oikeasti tarjoamat mallit OpenAI-yhteensopivasta
 * /models-rajapinnasta (LiteLLM-proxy tai OpenRouter). Tulos on välimuistissa,
 * jotta list_models ei kuormita rajapintaa. Epäonnistumista ei piilotettu:
 * kutsuja saa virheen tyypin ja HTTP-tilan (ei vastausrunkoa eikä osoitetta).
 */
export const MODELS_TIMEOUT_MS = 10_000;
export const MODELS_CACHE_TTL_MS = 60_000;

export interface AvailableModels {
  ids: string[];
  /** true, jos tulos tuli välimuistista. */
  cached: boolean;
  fetchedAt: number;
}

interface CacheEntry {
  key: string;
  value: AvailableModels;
}

let cache: CacheEntry | undefined;

export function clearModelsCache(): void {
  cache = undefined;
}

/** Virhe, jonka viesti on turvallista näyttää: vain tyyppi ja HTTP-tila. */
export class ModelsFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelsFetchError";
  }
}

export interface FetchModelsOptions {
  refresh?: boolean;
  /** Testejä varten. */
  now?: () => number;
}

export async function fetchAvailableModels(
  provider: ProviderConfig,
  opts: FetchModelsOptions = {},
): Promise<AvailableModels> {
  const now = opts.now ?? Date.now;
  const ttl = provider.modelsCacheTtlMs ?? MODELS_CACHE_TTL_MS;
  const ms = provider.modelsTimeoutMs ?? MODELS_TIMEOUT_MS;
  // Avain sisältää osoitteen ja avaimen; sitä ei koskaan tulosteta.
  const key = `${provider.baseUrl}\n${provider.apiKey}`;

  if (!opts.refresh && cache && cache.key === key && now() - cache.value.fetchedAt < ttl) {
    return { ...cache.value, cached: true };
  }

  let res: Response;
  try {
    res = await fetch(joinUrl(provider.baseUrl, "/models"), {
      headers: authHeaders(provider.apiKey),
      signal: AbortSignal.timeout(ms),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new ModelsFetchError(`mallilistan haku aikakatkaistiin (${ms} ms)`);
    }
    throw new ModelsFetchError(`mallilistan haku epäonnistui (${err instanceof Error ? err.name : typeof err})`);
  }
  if (!res.ok) {
    throw new ModelsFetchError(`mallilistan haku epäonnistui (HTTP ${res.status})`);
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch (err) {
    throw new ModelsFetchError(`mallilistan vastaus ei ole JSON-muodossa (${err instanceof Error ? err.name : typeof err})`);
  }
  const data = (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) {
    throw new ModelsFetchError("mallilistan vastauksesta puuttuu data-taulukko");
  }
  const ids = [
    ...new Set(
      data
        .map((m) => (m as { id?: unknown } | null)?.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ].sort();

  const value: AvailableModels = { ids, cached: false, fetchedAt: now() };
  cache = { key, value };
  return value;
}
