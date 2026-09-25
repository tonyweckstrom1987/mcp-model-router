import { readFileSync, existsSync } from "node:fs";
import { load as parseYaml } from "js-yaml";
import { AppConfigSchema, type AppConfig } from "./schema.js";

/**
 * Korvaa merkkijonoissa ${NIMI} ja ${NIMI:-oletus} -viittaukset ympäristömuuttujilla.
 * Oletusarvo voi itse sisältää uuden ${...}-viittauksen, joten korvaus ajetaan
 * sisimmästä ulospäin (RegExp ei osu sisäkkäisiin aaltosulkeisiin, joten silmukka
 * kutistaa lausekkeen kerroksittain).
 */
export function resolveEnvPlaceholders(input: string, env: NodeJS.ProcessEnv = process.env): string {
  const pattern = /\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^{}]*))?\}/g;
  let previous: string;
  let current = input;
  do {
    previous = current;
    current = current.replace(pattern, (_match, name: string, _hasDefault: string | undefined, fallback: string | undefined) => {
      const value = env[name];
      if (value !== undefined && value !== "") return value;
      return fallback ?? "";
    });
  } while (current !== previous);
  return current;
}

function resolveDeep<T>(value: T, env: NodeJS.ProcessEnv): T {
  if (typeof value === "string") {
    return resolveEnvPlaceholders(value, env) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveDeep(item, env)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = resolveDeep(val, env);
    }
    return result as unknown as T;
  }
  return value;
}

export interface LoadConfigOptions {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
}

export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const configPath = options.configPath ?? process.env.CONFIG_PATH ?? "config.yaml";
  const env = options.env ?? process.env;

  if (!existsSync(configPath)) {
    throw new Error(
      `Asetustiedostoa ei löytynyt polusta '${configPath}'. Kopioi config.example.yaml -> config.yaml ja muokkaa sitä, ` +
        `tai aseta CONFIG_PATH-ympäristömuuttuja osoittamaan omaan tiedostoosi.`,
    );
  }

  const raw = readFileSync(configPath, "utf8");
  const parsed = parseYaml(raw);
  const resolved = resolveDeep(parsed, env);

  const result = AppConfigSchema.safeParse(resolved);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(juuri)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Asetustiedosto '${configPath}' ei kelpaa:\n${issues}`);
  }
  return result.data;
}
