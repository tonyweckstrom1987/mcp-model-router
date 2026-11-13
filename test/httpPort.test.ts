import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_HTTP_PORT, InvalidEnvError, parseHttpPort } from "../src/transport/port.js";

describe("parseHttpPort", () => {
  it("puuttuva tai tyhjä arvo antaa oletusportin", () => {
    expect(parseHttpPort(undefined)).toBe(DEFAULT_HTTP_PORT);
    expect(parseHttpPort("")).toBe(DEFAULT_HTTP_PORT);
    expect(parseHttpPort("  ")).toBe(DEFAULT_HTTP_PORT);
  });

  it("hyväksyy kokonaisluvut 1–65535 (myös reunat ja välilyönnit)", () => {
    expect(parseHttpPort("1")).toBe(1);
    expect(parseHttpPort("3100")).toBe(3100);
    expect(parseHttpPort(" 8080 ")).toBe(8080);
    expect(parseHttpPort("65535")).toBe(65535);
  });

  it.each(["0", "65536", "99999", "3100abc", "abc", "-1", "31.5", "1e3", "0x50", "+80", "123456"])(
    "hylkää arvon %s",
    (raw) => {
      expect(() => parseHttpPort(raw)).toThrow(InvalidEnvError);
      expect(() => parseHttpPort(raw)).toThrow(/MCP_HTTP_PORT must be an integer between 1 and 65535/);
    },
  );
});

describe("virheellinen MCP_HTTP_PORT käynnistyksessä", () => {
  const dir = mkdtempSync(join(tmpdir(), "mmr-port-"));
  const configPath = join(dir, "config.yaml");
  copyFileSync("config.example.yaml", configPath);

  function run(port: string) {
    return spawnSync("node_modules/.bin/tsx", ["src/index.ts"], {
      encoding: "utf8",
      timeout: 20000,
      env: {
        ...process.env,
        CONFIG_PATH: configPath,
        DB_PATH: join(dir, `db-${port}.sqlite`),
        MCP_TRANSPORT: "http",
        MCP_AUTH_TOKEN: "x".repeat(40),
        MCP_HTTP_PORT: port,
      },
    });
  }

  it.each(["0", "3100abc", "abc"])(
    "arvo %s: koodi 1, selkeä viesti, ei pinojälkeä, ei kuuntelua eikä tietokantaa",
    (port) => {
      const res = run(port);
      const out = `${res.stdout}${res.stderr}`;
      expect(res.status).toBe(1);
      expect(out).toMatch(/mcp-model-router: MCP_HTTP_PORT must be an integer between 1 and 65535/);
      expect(out).not.toMatch(/kuuntelee osoitteessa/);
      expect(out).not.toMatch(/\n\s+at /);
      expect(existsSync(join(dir, `db-${port}.sqlite`))).toBe(false);
    },
    30000,
  );
});
