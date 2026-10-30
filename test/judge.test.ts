import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEval, parseJudgeScore, DEFAULT_JUDGE_MAX_TOKENS } from "../src/eval/runEval.js";
import type { AppConfig } from "../src/config/schema.js";
import { AppConfigSchema } from "../src/config/schema.js";

describe("parseJudgeScore", () => {
  it.each([
    ["4", 4],
    [" 5\n", 5],
    ["3.5", 3.5],
    ["3,5", 3.5],
    ["4/5", 4],
    ["Arvio: 4 / 5", 4],
    ["Pisteet: 2", 2],
  ])("hyväksyy %j -> %d", (text, expected) => {
    expect(parseJudgeScore(text)).toBe(expected);
  });

  it.each([
    ["Pisteet 10/10"],
    ["Arvio: 8/10"],
    ["vuonna 2024"],
    ["0"],
    ["6"],
    ["en osaa arvioida"],
    [""],
    ["Annan 4, mutta ehkä 2"],
  ])("hylkää %j", (text) => {
    expect(parseJudgeScore(text)).toBeNull();
  });

  it("hyväksyy toistuvan saman pisteen", () => {
    expect(parseJudgeScore("4. Lopullinen arvio: 4/5")).toBe(4);
  });
});

describe("run_eval: LLM-tuomari", () => {
  let mockAgent: MockAgent;
  const originalDispatcher = getGlobalDispatcher();
  let evalDir: string;
  const originalEvalDir = process.env.EVAL_DIR;
  let counter = 0;

  function config(judgeOverrides: Partial<AppConfig["eval"]["judge"]> = {}): AppConfig {
    return {
      server: { name: "test", version: "0.0.0" },
      provider: { baseUrl: "http://litellm.local:4000", apiKey: "", timeoutMs: 5000, kind: "litellm" },
      tasks: { general: { model: "m1" } },
      usage: { provider: "litellm", baseUrl: "http://litellm.local:4000", apiKey: "" },
      eval: { judge: { enabled: true, model: "judge-model", ...judgeOverrides }, pricing: {}, concurrency: 1, allowedModels: ["model-a"] },
      database: { path: ":memory:" },
    } as AppConfig;
  }

  function promptSet(): string {
    const path = join(evalDir, `judge-${counter++}.json`);
    writeFileSync(path, JSON.stringify([{ id: "p1", prompt: "Sano hei" }]), "utf8");
    return path;
  }

  beforeAll(() => {
    evalDir = mkdtempSync(join(tmpdir(), "mcp-model-router-judge-"));
    process.env.EVAL_DIR = evalDir;
  });

  afterAll(() => {
    if (originalEvalDir === undefined) delete process.env.EVAL_DIR;
    else process.env.EVAL_DIR = originalEvalDir;
    rmSync(evalDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
  });

  afterEach(async () => {
    setGlobalDispatcher(originalDispatcher);
    await mockAgent.close();
  });

  function answer(content: string) {
    return { choices: [{ message: { content } }], usage: { prompt_tokens: 5, completion_tokens: 1 } };
  }

  it("tuomarikutsu käyttää pientä max_tokens-arvoa ja pisteet tallentuvat", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const pool = mockAgent.get("http://litellm.local:4000");
    pool
      .intercept({ path: "/chat/completions", method: "POST" })
      .reply(200, (opts) => {
        bodies.push(JSON.parse(String(opts.body)));
        return answer("hei");
      });
    pool
      .intercept({ path: "/chat/completions", method: "POST" })
      .reply(200, (opts) => {
        bodies.push(JSON.parse(String(opts.body)));
        return answer("4");
      });

    const report = await runEval(config(), { promptSetPath: promptSet(), models: ["model-a"] });

    expect(report.cases[0].judgeScore).toBe(4);
    expect(report.cases[0].judgeError).toBeNull();
    expect(report.perModel[0].judgeErrorCount).toBe(0);
    expect(bodies[1].model).toBe("judge-model");
    expect(bodies[1].max_tokens).toBe(DEFAULT_JUDGE_MAX_TOKENS);
  });

  it("eval.judge.maxTokens ohittaa oletuksen", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const pool = mockAgent.get("http://litellm.local:4000");
    pool.intercept({ path: "/chat/completions", method: "POST" }).reply(200, answer("hei"));
    pool
      .intercept({ path: "/chat/completions", method: "POST" })
      .reply(200, (opts) => {
        bodies.push(JSON.parse(String(opts.body)));
        return answer("5");
      });

    const report = await runEval(config({ maxTokens: 256 }), { promptSetPath: promptSet(), models: ["model-a"] });
    expect(report.cases[0].judgeScore).toBe(5);
    expect(bodies[0].max_tokens).toBe(256);
  });

  it("selittävä vastaus '10/10' ei vääristä keskiarvoa vaan kirjataan tuomarivirheeksi", async () => {
    const pool = mockAgent.get("http://litellm.local:4000");
    pool.intercept({ path: "/chat/completions", method: "POST" }).reply(200, answer("hei"));
    pool.intercept({ path: "/chat/completions", method: "POST" }).reply(200, answer("Arvio: 10/10"));

    const report = await runEval(config(), { promptSetPath: promptSet(), models: ["model-a"] });

    expect(report.cases[0].judgeScore).toBeNull();
    expect(report.cases[0].judgeError).toMatch(/yksiselitteistä pistettä/);
    expect(report.cases[0].error).toBeNull();
    expect(report.cases[0].response).toBe("hei");
    expect(report.perModel[0].avgJudgeScore).toBeNull();
    expect(report.perModel[0].judgeErrorCount).toBe(1);
  });

  it("tuomarikutsun virhe näkyy raportissa eikä hukkaa mallin vastausta", async () => {
    const pool = mockAgent.get("http://litellm.local:4000");
    pool.intercept({ path: "/chat/completions", method: "POST" }).reply(200, answer("hei"));
    pool.intercept({ path: "/chat/completions", method: "POST" }).reply(500, { error: "rikki" });

    const report = await runEval(config(), { promptSetPath: promptSet(), models: ["model-a"] });

    expect(report.cases[0].response).toBe("hei");
    expect(report.cases[0].error).toBeNull();
    expect(report.cases[0].judgeScore).toBeNull();
    expect(report.cases[0].judgeError).toBeTruthy();
    expect(report.perModel[0].judgeErrorCount).toBe(1);
  });

  it("ilman tuomaria judgeError on null", async () => {
    const pool = mockAgent.get("http://litellm.local:4000");
    pool.intercept({ path: "/chat/completions", method: "POST" }).reply(200, answer("hei"));

    const report = await runEval(config({ enabled: false }), { promptSetPath: promptSet(), models: ["model-a"] });
    expect(report.cases[0].judgeError).toBeNull();
    expect(report.perModel[0].judgeErrorCount).toBe(0);
  });

  it("konfiguraatio hylkää maxTokens-arvon yli kutsukohtaisen katon", () => {
    const base = {
      provider: { baseUrl: "http://x.local" },
      tasks: { general: { model: "m1" } },
      usage: { baseUrl: "http://x.local" },
    };
    expect(AppConfigSchema.safeParse({ ...base, eval: { judge: { maxTokens: 5000 } } }).success).toBe(false);
    expect(AppConfigSchema.safeParse({ ...base, eval: { judge: { maxTokens: 64 } } }).success).toBe(true);
  });
});
