import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEval } from "../src/eval/runEval.js";
import type { AppConfig } from "../src/config/schema.js";

function baseConfig(overrides: Partial<AppConfig["eval"]> = {}): AppConfig {
  return {
    server: { name: "test", version: "0.0.0" },
    provider: { baseUrl: "http://litellm.local:4000", apiKey: "", timeoutMs: 5000, kind: "litellm" },
    tasks: { general: { model: "m1" } },
    usage: { provider: "litellm", baseUrl: "http://litellm.local:4000", apiKey: "" },
    eval: { judge: { enabled: false }, pricing: {}, ...overrides },
    database: { path: ":memory:" },
  };
}

describe("runEval", () => {
  let mockAgent: MockAgent;
  const originalDispatcher = getGlobalDispatcher();
  const dirs: string[] = [];

  beforeEach(() => {
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
  });

  afterEach(async () => {
    setGlobalDispatcher(originalDispatcher);
    await mockAgent.close();
  });

  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  function writePromptSet(json: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), "mcp-model-router-eval-"));
    dirs.push(dir);
    const path = join(dir, "prompts.json");
    writeFileSync(path, JSON.stringify(json), "utf8");
    return path;
  }

  it("ajaa promptit kahdella mallilla ja laskee läpäisyn expectedContains-kentästä", async () => {
    const promptPath = writePromptSet([
      { id: "p1", prompt: "Mikä on 2+2?", expectedContains: "4" },
      { id: "p2", prompt: "Sano hei", expectedContains: "hei" },
    ]);

    const pool = mockAgent.get("http://litellm.local:4000");
    pool
      .intercept({ path: "/chat/completions", method: "POST" })
      .reply(200, { model: "model-a", choices: [{ message: { content: "vastaus: 4" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } })
      .times(1);
    pool
      .intercept({ path: "/chat/completions", method: "POST" })
      .reply(200, { model: "model-a", choices: [{ message: { content: "vastaus ilman tervehdystä" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } })
      .times(1);
    pool
      .intercept({ path: "/chat/completions", method: "POST" })
      .reply(200, { model: "model-b", choices: [{ message: { content: "tulos on 4" } }], usage: { prompt_tokens: 8, completion_tokens: 4 } })
      .times(1);
    pool
      .intercept({ path: "/chat/completions", method: "POST" })
      .reply(200, { model: "model-b", choices: [{ message: { content: "hei sinulle" } }], usage: { prompt_tokens: 8, completion_tokens: 4 } })
      .times(1);

    const report = await runEval(baseConfig(), { promptSetPath: promptPath, models: ["model-a", "model-b"] });

    expect(report.cases).toHaveLength(4);
    const modelA = report.perModel.find((m) => m.model === "model-a")!;
    const modelB = report.perModel.find((m) => m.model === "model-b")!;
    expect(modelA.passRate).toBe(0.5);
    expect(modelB.passRate).toBe(1);
  });

  it("laskee hinnan konfiguroidusta hinnastosta", async () => {
    const promptPath = writePromptSet([{ id: "p1", prompt: "Hei" }]);

    const pool = mockAgent.get("http://litellm.local:4000");
    pool
      .intercept({ path: "/chat/completions", method: "POST" })
      .reply(200, {
        model: "model-a",
        choices: [{ message: { content: "vastaus" } }],
        usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
      });

    const config = baseConfig({
      pricing: { "model-a": { inputPerMillionUsd: 1, outputPerMillionUsd: 2 } },
    });

    const report = await runEval(config, { promptSetPath: promptPath, models: ["model-a"] });

    expect(report.cases[0].priceUsd).toBe(3);
  });

  it("merkitsee virheen kun mallikutsu epäonnistuu, eikä keskeytä muita malleja", async () => {
    const promptPath = writePromptSet([{ id: "p1", prompt: "Hei" }]);

    const pool = mockAgent.get("http://litellm.local:4000");
    pool.intercept({ path: "/chat/completions", method: "POST" }).reply(500, "virhe").times(1);
    pool
      .intercept({ path: "/chat/completions", method: "POST" })
      .reply(200, { model: "model-b", choices: [{ message: { content: "ok" } }] })
      .times(1);

    const report = await runEval(baseConfig(), { promptSetPath: promptPath, models: ["model-a", "model-b"] });

    const modelA = report.perModel.find((m) => m.model === "model-a")!;
    const modelB = report.perModel.find((m) => m.model === "model-b")!;
    expect(modelA.errorCount).toBe(1);
    expect(modelB.errorCount).toBe(0);
  });
});
