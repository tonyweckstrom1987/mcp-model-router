import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveEnvPlaceholders, loadConfig } from "../src/config/load.js";

describe("resolveEnvPlaceholders", () => {
  it("korvaa ${NIMI}-viittauksen ympäristömuuttujalla", () => {
    const result = resolveEnvPlaceholders("arvo: ${FOO}", { FOO: "bar" });
    expect(result).toBe("arvo: bar");
  });

  it("käyttää oletusarvoa kun muuttujaa ei ole asetettu", () => {
    const result = resolveEnvPlaceholders("arvo: ${FOO:-oletus}", {});
    expect(result).toBe("arvo: oletus");
  });

  it("tukee sisäkkäisiä oletusarvoja", () => {
    const result = resolveEnvPlaceholders("arvo: ${FOO:-${BAR:-perus}}", {});
    expect(result).toBe("arvo: perus");
  });

  it("ei muuta tekstiä jos placeholderia ei ole", () => {
    const result = resolveEnvPlaceholders("ei placeholderia", {});
    expect(result).toBe("ei placeholderia");
  });
});

describe("loadConfig", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  function writeConfig(yaml: string): string {
    const dir = mkdtempSync(join(tmpdir(), "mcp-model-router-test-"));
    dirs.push(dir);
    const path = join(dir, "config.yaml");
    writeFileSync(path, yaml, "utf8");
    return path;
  }

  it("lataa ja validoi kelvollisen asetustiedoston", () => {
    const path = writeConfig(`
provider:
  baseUrl: http://localhost:4000
tasks:
  general:
    model: some-model
usage:
  baseUrl: http://localhost:4000
`);
    const config = loadConfig({ configPath: path, env: {} });
    expect(config.provider.baseUrl).toBe("http://localhost:4000");
    expect(config.tasks.general.model).toBe("some-model");
    expect(config.usage.provider).toBe("litellm");
  });

  it("heittää selkeän virheen puuttuvasta tiedostosta", () => {
    expect(() => loadConfig({ configPath: "/ei/olemassa/config.yaml", env: {} })).toThrow(/ei löytynyt/);
  });

  it("heittää selkeän virheen puuttuvista pakollisista kentistä", () => {
    const path = writeConfig(`
provider:
  baseUrl: http://localhost:4000
tasks: {}
usage:
  baseUrl: http://localhost:4000
`);
    expect(() => loadConfig({ configPath: path, env: {} })).toThrow(/tasks/);
  });

  it("lukee tehtävätyyppikohtaisen timeoutMs:n, joka on oletuksena määrittelemätön", () => {
    const path = writeConfig(`
provider:
  baseUrl: http://localhost:4000
tasks:
  general:
    model: some-model
  orchestration:
    model: some-other-model
    timeoutMs: 180000
usage:
  baseUrl: http://localhost:4000
`);
    const config = loadConfig({ configPath: path, env: {} });
    expect(config.tasks.general.timeoutMs).toBeUndefined();
    expect(config.tasks.orchestration.timeoutMs).toBe(180_000);
  });

  it("resolvoi ympäristömuuttujat ennen validointia", () => {
    const path = writeConfig(`
provider:
  baseUrl: \${LLM_BASE_URL}
tasks:
  general:
    model: some-model
usage:
  baseUrl: \${LLM_BASE_URL}
`);
    const config = loadConfig({ configPath: path, env: { LLM_BASE_URL: "http://litellm.local:4000" } });
    expect(config.provider.baseUrl).toBe("http://litellm.local:4000");
  });
});
