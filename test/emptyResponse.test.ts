import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/lib/db.js";
import { budgetFor } from "../src/lib/budget.js";
import { callChatCompletion } from "../src/lib/openaiClient.js";
import { routeAndComplete } from "../src/router/routeAndComplete.js";
import { runEval } from "../src/eval/runEval.js";
import { EmptyResponseError, EMPTY_RESPONSE_CODE } from "../src/lib/limits.js";
import type { AppConfig } from "../src/config/schema.js";

const BASE = "http://litellm.local:4000";

describe("tyhjien vastausten käsittely", () => {
  let mockAgent: MockAgent;
  const originalDispatcher = getGlobalDispatcher();
  let db: Db;

  beforeEach(() => {
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
    db = new Db(":memory:");
  });

  afterEach(async () => {
    setGlobalDispatcher(originalDispatcher);
    await mockAgent.close();
    db.close();
  });

  const reply = (body: unknown, status = 200) =>
    mockAgent.get(BASE).intercept({ path: "/chat/completions", method: "POST" }).reply(status, body as object);

  const call = () =>
    callChatCompletion({ baseUrl: BASE, model: "m", messages: [{ role: "user", content: "hei" }], budget: budgetFor(db) });

  describe("callChatCompletion", () => {
    const emptyBodies: Array<[string, unknown]> = [
      ["tyhjä merkkijono", { choices: [{ message: { content: "" } }] }],
      ["pelkkä whitespace", { choices: [{ message: { content: " \n\t  " } }] }],
      ["content null", { choices: [{ message: { content: null } }] }],
      ["content puuttuu", { choices: [{ message: {} }] }],
      ["message puuttuu", { choices: [{}] }],
      ["choices tyhjä", { choices: [] }],
      ["choices puuttuu", {}],
      ["content ei ole merkkijono", { choices: [{ message: { content: [{ type: "text", text: "x" }] } }] }],
      ["katkaistu tyhjäksi (finish_reason=length)", { choices: [{ message: { content: "" }, finish_reason: "length" }] }],
    ];

    for (const [name, body] of emptyBodies) {
      it(`${name} -> ${EMPTY_RESPONSE_CODE}`, async () => {
        reply(body);
        const err = await call().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(EmptyResponseError);
        expect((err as EmptyResponseError).code).toBe(EMPTY_RESPONSE_CODE);
        expect((err as Error).message).toContain(EMPTY_RESPONSE_CODE);
      });
    }

    it("katkaistu JSON-runko ei ole onnistuminen", async () => {
      mockAgent
        .get(BASE)
        .intercept({ path: "/chat/completions", method: "POST" })
        .reply(200, '{"choices":[{"message":{"content":"puol');
      await expect(call()).rejects.toThrow();
    });

    it("epätyhjä vastaus (myös katkaistu finish_reason=length) on edelleen onnistuminen", async () => {
      reply({ choices: [{ message: { content: "osittain" }, finish_reason: "length" }] });
      const result = await call();
      expect(result.text).toBe("osittain");
    });

    it("tyhjä vastaus kuluttaa silti budjettia", async () => {
      reply({ choices: [{ message: { content: "" } }], usage: { total_tokens: 77 } });
      await expect(call()).rejects.toBeInstanceOf(EmptyResponseError);
      const { budgetDay } = await import("../src/lib/limits.js");
      expect(db.getReservedTokens(budgetDay(new Date()))).toBe(77);
    });
  });

  describe("route_and_complete", () => {
    const config = (fallback: boolean): AppConfig => ({
      server: { name: "t", version: "0" },
      provider: { baseUrl: BASE, apiKey: "", timeoutMs: 5000, kind: "litellm" },
      tasks: { general: { model: "primary", ...(fallback ? { fallbackModel: "fallback" } : {}) } },
      usage: { provider: "litellm", baseUrl: BASE, apiKey: "" },
      eval: { judge: { enabled: false }, pricing: {}, concurrency: 1 },
      database: { path: ":memory:" },
    });

    it("tyhjä vastaus ilman varamallia on virhe eikä onnistuminen, ja se kirjataan virheeksi", async () => {
      reply({ choices: [{ message: { content: "  " } }] });
      await expect(routeAndComplete(config(false), { taskType: "general", prompt: "hei" }, db)).rejects.toThrow(
        EMPTY_RESPONSE_CODE,
      );
      const logs = db.listRecentCallLogs(1) as Array<{ status: string }>;
      expect(logs[0].status).toBe("error");
    });

    it("tyhjä päämallin vastaus siirtyy varamalliin", async () => {
      reply({ choices: [{ message: { content: "" } }] });
      reply({ model: "fallback", choices: [{ message: { content: "varmalli vastasi" } }] });
      const result = await routeAndComplete(config(true), { taskType: "general", prompt: "hei" }, db);
      expect(result.usedFallback).toBe(true);
      expect(result.text).toBe("varmalli vastasi");
    });

    it("tyhjä varamallin vastaus on myös virhe", async () => {
      reply({ choices: [{ message: { content: "" } }] });
      reply({ choices: [{ message: { content: "" } }] });
      await expect(routeAndComplete(config(true), { taskType: "general", prompt: "hei" }, db)).rejects.toThrow(
        EMPTY_RESPONSE_CODE,
      );
    });
  });

  describe("run_eval", () => {
    let dir: string;
    const config = (): AppConfig => ({
      server: { name: "t", version: "0" },
      provider: { baseUrl: BASE, apiKey: "", timeoutMs: 5000, kind: "litellm" },
      tasks: { general: { model: "m" } },
      usage: { provider: "litellm", baseUrl: BASE, apiKey: "" },
      eval: { judge: { enabled: false }, pricing: {}, concurrency: 1 },
      database: { path: ":memory:" },
    });

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "mcp-empty-"));
      writeFileSync(join(dir, "p.json"), JSON.stringify([{ id: "a-1", prompt: "k", expectedContains: "ok" }]));
      writeFileSync(join(dir, "noexp.json"), JSON.stringify([{ id: "b-1", prompt: "k" }]));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    for (const [name, body] of [
      ["tyhjä merkkijono", { choices: [{ message: { content: "" } }] }],
      ["whitespace", { choices: [{ message: { content: "   " } }] }],
      ["null", { choices: [{ message: { content: null } }] }],
      ["puuttuva content", { choices: [{ message: {} }] }],
      ["katkaistu tyhjäksi", { choices: [{ message: { content: "" }, finish_reason: "length" }] }],
    ] as Array<[string, unknown]>) {
      it(`${name}: tapaus epäonnistuu virhekoodilla eikä ole läpäisty`, async () => {
        reply(body);
        const report = await runEval(config(), { promptSetPath: "p.json", models: ["m"] }, db, { evalDir: dir });
        const c = report.cases[0];
        expect(c.error).toContain(EMPTY_RESPONSE_CODE);
        expect(c.passed).toBe(false);
        expect(c.response).toBe("");
        expect(report.perModel[0].passRate).toBe(0);
        expect(report.perModel[0].errorCount).toBe(1);
        expect(report.perTaskType[0].passRateIncludingErrors).toBe(0);
      });
    }

    it("tyhjä vastaus on epäonnistuminen myös ilman expectedContains-kenttää (ei null/onnistunut)", async () => {
      reply({ choices: [{ message: { content: "" } }] });
      const report = await runEval(config(), { promptSetPath: "noexp.json", models: ["m"] }, db, { evalDir: dir });
      expect(report.cases[0].passed).toBe(false);
      expect(report.cases[0].error).toContain(EMPTY_RESPONSE_CODE);
    });

    it("virhekoodi tallentuu tietokantaan", async () => {
      reply({ choices: [{ message: { content: "" } }] });
      const report = await runEval(config(), { promptSetPath: "p.json", models: ["m"] }, db, { evalDir: dir });
      const rows = db.getEvalRunResults(report.runId) as Array<{ error_message: string; passed: number }>;
      expect(rows[0].error_message).toContain(EMPTY_RESPONSE_CODE);
      expect(rows[0].passed).toBe(0);
    });
  });
});
