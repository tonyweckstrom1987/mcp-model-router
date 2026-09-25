import type { ProviderConfig } from "../config/schema.js";

const OPENROUTER_PREFIX = "openrouter/";

/**
 * config.yaml:ssa mallit kirjoitetaan aina samassa muodossa
 * (esim. "openrouter/deepseek/deepseek-v4.1-flash"), joka on LiteLLM:n
 * käyttämä reititystunniste. Kun provider.baseUrl osoittaa suoraan
 * OpenRouteriin (provider.kind: "openrouter"), OpenRouterin oma API ei
 * tunne tätä etuliitettä, joten se karsitaan ennen rajapintakutsua.
 * LiteLLM:n kanssa (provider.kind: "litellm", oletus) tunniste lähetetään
 * sellaisenaan.
 */
export function resolveModelId(provider: Pick<ProviderConfig, "kind">, modelId: string): string {
  if (provider.kind === "openrouter" && modelId.startsWith(OPENROUTER_PREFIX)) {
    return modelId.slice(OPENROUTER_PREFIX.length);
  }
  return modelId;
}
