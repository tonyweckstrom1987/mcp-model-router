import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEval } from "../src/eval/runEval.js";
import { Db } from "../src/lib/db.js";
import type { AppConfig } from "../src/config/schema.js";

function baseConfig(overrides: Partial<AppConfig["eval"]> = {}): AppConfig {
  return {
    server: { name: "test", version: "0.0.0" },
    provider: { baseUrl: "http://litellm.local:4000", apiKey: "", timeoutMs: 5000, kind: "litellm" },
    tasks: { general: { model: "m1" } },
    usage: { provider: "litellm", baseUrl: "http://litellm.local:4000", apiKey: "" },
    eval: { judge: { enabled: false }, pricing: {}, concurrency: 4, ...overrides },
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

  it("ryhmittelee tulokset tehtävätyypeittäin promptId:n etuliitteen mukaan ja laskee molemmat läpäisyprosentit", async () => {
    const promptPath = writePromptSet([
      { id: "yleinen-01", prompt: "K1", expectedContains: "ok" },
      { id: "yleinen-02", prompt: "K2", expectedContains: "ok" },
      { id: "pilkkominen-01", prompt: "K3", expectedContains: "budjetti" },
      { id: "pilkkominen-02", prompt: "K4", expectedContains: "budjetti" },
    ]);

    const pool = mockAgent.get("http://litellm.local:4000");
    // yleinen-01: läpäisee
    pool.intercept({ path: "/chat/completions", method: "POST" }).reply(200, { model: "model-a", choices: [{ message: { content: "ok kyllä" } }] }).times(1);
    // yleinen-02: ei läpäise
    pool.intercept({ path: "/chat/completions", method: "POST" }).reply(200, { model: "model-a", choices: [{ message: { content: "väärä vastaus" } }] }).times(1);
    // pilkkominen-01: virhe (esim. aikakatkaisu)
    pool.intercept({ path: "/chat/completions", method: "POST" }).reply(500, "virhe").times(1);
    // pilkkominen-02: läpäisee
    pool
      .intercept({ path: "/chat/completions", method: "POST" })
      .reply(200, { model: "model-a", choices: [{ message: { content: "tarvitaan budjetti" } }] })
      .times(1);

    const report = await runEval(baseConfig(), { promptSetPath: promptPath, models: ["model-a"] });

    expect(report.perTaskType).toHaveLength(2);

    const yleinen = report.perTaskType.find((t) => t.taskType === "yleinen")!;
    expect(yleinen.caseCount).toBe(2);
    expect(yleinen.errorCount).toBe(0);
    expect(yleinen.passedCount).toBe(1);
    expect(yleinen.expectedCount).toBe(2);
    expect(yleinen.passRateExcludingErrors).toBe(0.5);
    expect(yleinen.passRateIncludingErrors).toBe(0.5);

    const pilkkominen = report.perTaskType.find((t) => t.taskType === "pilkkominen")!;
    expect(pilkkominen.caseCount).toBe(2);
    expect(pilkkominen.errorCount).toBe(1);
    expect(pilkkominen.passedCount).toBe(1);
    expect(pilkkominen.expectedCount).toBe(2);
    // Virhe pois nimittäjästä: 1/1 = 100 %
    expect(pilkkominen.passRateExcludingErrors).toBe(1);
    // Virhe mukana nimittäjässä epäonnistumisena: 1/2 = 50 %
    expect(pilkkominen.passRateIncludingErrors).toBe(0.5);
  });

  it("kirjoittaa eval_run- ja eval_result-rivit oikeassa järjestyksessä oikeaan tietokantaan", async () => {
    const promptPath = writePromptSet([{ id: "p1", prompt: "Hei", expectedContains: "moi" }]);

    const pool = mockAgent.get("http://litellm.local:4000");
    pool
      .intercept({ path: "/chat/completions", method: "POST" })
      .reply(200, { model: "model-a", choices: [{ message: { content: "moi sinne" } }] });

    const db = new Db(":memory:");
    const report = await runEval(baseConfig(), { promptSetPath: promptPath, models: ["model-a"] }, db);

    const rows = db.getEvalRunResults(report.runId) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].model).toBe("model-a");
    db.close();
  });

  it("säilyttää tulosten järjestyksen, vaikka rinnakkaiset kutsut valmistuisivat eri järjestyksessä", async () => {
    // p1 vastaa hitaammin kuin p2, mutta tuloksen pitää silti tulla ennen
    // p2:ta - järjestys tulee promptien järjestyksestä, ei valmistumisjärjestyksestä.
    const promptPath = writePromptSet([
      { id: "p1", prompt: "hidas" },
      { id: "p2", prompt: "nopea" },
    ]);

    const pool = mockAgent.get("http://litellm.local:4000");
    pool
      .intercept({ path: "/chat/completions", method: "POST", body: (b) => JSON.parse(b as string).messages[0].content === "hidas" })
      .reply(200, { model: "model-a", choices: [{ message: { content: "hidas vastaus" } }] })
      .delay(30);
    pool
      .intercept({ path: "/chat/completions", method: "POST", body: (b) => JSON.parse(b as string).messages[0].content === "nopea" })
      .reply(200, { model: "model-a", choices: [{ message: { content: "nopea vastaus" } }] });

    const report = await runEval(baseConfig({ concurrency: 4 }), { promptSetPath: promptPath, models: ["model-a"] });

    expect(report.cases.map((c) => c.promptId)).toEqual(["p1", "p2"]);
    expect(report.cases[0].response).toBe("hidas vastaus");
    expect(report.cases[1].response).toBe("nopea vastaus");
  });

  it("rajoittaa samanaikaisten kutsujen määrän config.eval.concurrency:iin", async () => {
    // MockAgentin oma delay() ei sovi tähän, koska sen callback suoritetaan
    // pyynnön saapuessa (ennen viivettä) - se ei kerro milloin vastaus
    // todella valmistuu. Ohitetaan siksi globaali fetch suoraan, jotta
    // inFlight-laskuria voi laskea alas vasta kun "kutsu" oikeasti päättyy.
    const promptPath = writePromptSet([
      { id: "p1", prompt: "a" },
      { id: "p2", prompt: "b" },
      { id: "p3", prompt: "c" },
      { id: "p4", prompt: "d" },
    ]);

    let inFlight = 0;
    let maxInFlight = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      return new Response(JSON.stringify({ model: "model-a", choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const report = await runEval(baseConfig({ concurrency: 2 }), { promptSetPath: promptPath, models: ["model-a"] });
      expect(report.cases).toHaveLength(4);
      expect(maxInFlight).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
