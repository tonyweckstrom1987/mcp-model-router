import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/lib/db.js";
import { createTokenBudget } from "../src/lib/budget.js";
import { callChatCompletion } from "../src/lib/openaiClient.js";
import { routeAndComplete } from "../src/router/routeAndComplete.js";
import { runEval } from "../src/eval/runEval.js";
import {
  DAILY_TOKEN_BUDGET,
  MAX_CALLS_PER_EVAL_RUN,
  MAX_TOKENS_PER_CALL,
  LimitExceededError,
  budgetDay,
} from "../src/lib/limits.js";
import type { AppConfig } from "../src/config/schema.js";

const BASE = "http://litellm.local:4000";

function okReply(usage?: { total_tokens: number }) {
  return { model: "m", choices: [{ message: { content: "ok" } }], ...(usage ? { usage } : {}) };
}

describe("kustannuskatot", () => {
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
    vi.useRealTimers();
    setGlobalDispatcher(originalDispatcher);
    await mockAgent.close();
    db.close();
  });

  const call = (maxTokens?: number, content = "Hei") =>
    callChatCompletion({
      baseUrl: BASE,
      model: "m",
      messages: [{ role: "user", content }],
      maxTokens,
      budget: createTokenBudget(db),
    });

  describe("max_tokens per kutsu", () => {
    it("täsmälleen katto sallitaan ja lähetetään sellaisenaan", async () => {
      let sent: number | undefined;
      mockAgent
        .get(BASE)
        .intercept({ path: "/chat/completions", method: "POST" })
        .reply(200, (opts) => {
          sent = JSON.parse(String(opts.body)).max_tokens;
          return okReply({ total_tokens: 5 });
        });
      await call(MAX_TOKENS_PER_CALL);
      expect(sent).toBe(MAX_TOKENS_PER_CALL);
    });

    it("katon ylitys hylätään virheellä eikä pienennetä hiljaa; kutsua ei tehdä eikä budjettia varata", async () => {
      // disableNetConnect ja ei interceptiä: kutsun yritys kaataisi testin eri virheeseen
      await expect(call(MAX_TOKENS_PER_CALL + 1)).rejects.toBeInstanceOf(LimitExceededError);
      expect(db.getReservedTokens(budgetDay(new Date()))).toBe(0);
    });

    it("epäkelvot arvot (0, negatiivinen, murtoluku, NaN) hylätään", async () => {
      for (const bad of [0, -1, 1.5, Number.NaN]) {
        await expect(call(bad)).rejects.toBeInstanceOf(LimitExceededError);
      }
    });

    it("ilman maxTokensia lähetetään katto, ei rajatonta", async () => {
      let sent: number | undefined;
      mockAgent
        .get(BASE)
        .intercept({ path: "/chat/completions", method: "POST" })
        .reply(200, (opts) => {
          sent = JSON.parse(String(opts.body)).max_tokens;
          return okReply({ total_tokens: 5 });
        });
      await call();
      expect(sent).toBe(MAX_TOKENS_PER_CALL);
    });
  });

  describe("päiväbudjetti", () => {
    it("varaus tehdään ennen kutsua ja korjataan toteutuneeseen usageen", async () => {
      let reservedDuringCall = -1;
      mockAgent
        .get(BASE)
        .intercept({ path: "/chat/completions", method: "POST" })
        .reply(200, () => {
          reservedDuringCall = db.getReservedTokens(budgetDay(new Date()));
          return okReply({ total_tokens: 42 });
        });
      await call();
      expect(reservedDuringCall).toBeGreaterThanOrEqual(MAX_TOKENS_PER_CALL);
      expect(db.getReservedTokens(budgetDay(new Date()))).toBe(42);
    });

    it("jos usage puuttuu, varaus jää voimaan (fail closed)", async () => {
      mockAgent.get(BASE).intercept({ path: "/chat/completions", method: "POST" }).reply(200, okReply());
      await call(100);
      expect(db.getReservedTokens(budgetDay(new Date()))).toBeGreaterThanOrEqual(100);
    });

    it("epäonnistunut kutsu kuluttaa budjettia (varaus ei vapaudu)", async () => {
      mockAgent.get(BASE).intercept({ path: "/chat/completions", method: "POST" }).reply(500, "virhe");
      await expect(call(100)).rejects.toThrow(/500/);
      expect(db.getReservedTokens(budgetDay(new Date()))).toBeGreaterThanOrEqual(100);
    });

    it("raja täsmälleen: budjetin täyttävä varaus sallitaan, seuraava pienikin hylätään", () => {
      const budget = createTokenBudget(db);
      budget.reserve(DAILY_TOKEN_BUDGET);
      expect(db.getReservedTokens(budgetDay(new Date()))).toBe(DAILY_TOKEN_BUDGET);
      expect(() => budget.reserve(1)).toThrow(LimitExceededError);
      expect(db.getReservedTokens(budgetDay(new Date()))).toBe(DAILY_TOKEN_BUDGET);
    });

    it("raja ylitetty: kutsu hylätään eikä lähetetä", async () => {
      createTokenBudget(db).reserve(DAILY_TOKEN_BUDGET - 10);
      // Ei interceptiä: lähetetty kutsu antaisi eri virheen kuin LimitExceededError
      await expect(call(100)).rejects.toBeInstanceOf(LimitExceededError);
    });

    it("rinnakkaiset varaukset eivät ohita rajaa (kaksi yhteyttä samaan tiedostoon)", async () => {
      const dir = mkdtempSync(join(tmpdir(), "mcp-budget-"));
      const a = new Db(join(dir, "b.sqlite"));
      const b = new Db(join(dir, "b.sqlite"));
      try {
        const ba = createTokenBudget(a);
        const bb = createTokenBudget(b);
        const chunk = 10_000;
        const attempts = 150; // 150 * 10 000 = 1,5 M > 1 M
        let granted = 0;
        await Promise.all(
          Array.from({ length: attempts }, async (_, i) => {
            try {
              (i % 2 === 0 ? ba : bb).reserve(chunk);
              granted += 1;
            } catch (err) {
              expect(err).toBeInstanceOf(LimitExceededError);
            }
          }),
        );
        expect(granted).toBe(DAILY_TOKEN_BUDGET / chunk);
        expect(a.getReservedTokens(budgetDay(new Date()))).toBe(DAILY_TOKEN_BUDGET);
      } finally {
        a.close();
        b.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("rinnakkaiset callChatCompletion-kutsut eivät ylitä budjettia", async () => {
      createTokenBudget(db).reserve(DAILY_TOKEN_BUDGET - 2 * (MAX_TOKENS_PER_CALL + 10));
      mockAgent.get(BASE).intercept({ path: "/chat/completions", method: "POST" }).reply(200, okReply()).times(10);
      const results = await Promise.allSettled(Array.from({ length: 5 }, () => call()));
      const ok = results.filter((r) => r.status === "fulfilled").length;
      const limited = results.filter((r) => r.status === "rejected" && r.reason instanceof LimitExceededError).length;
      expect(ok).toBe(2);
      expect(limited).toBe(3);
    });

    it("päivä määritellään Europe/Helsinki-ajassa ja budjetti nollautuu uutena päivänä", () => {
      // 2026-01-01T22:30Z on Helsingissä jo 2026-01-02 (UTC+2)
      expect(budgetDay(new Date("2026-01-01T22:30:00Z"))).toBe("2026-01-02");
      expect(budgetDay(new Date("2026-01-01T21:30:00Z"))).toBe("2026-01-01");
      // Kesäaika (UTC+3)
      expect(budgetDay(new Date("2026-07-01T21:30:00Z"))).toBe("2026-07-02");

      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-10T10:00:00Z"));
      const budget = createTokenBudget(db);
      budget.reserve(DAILY_TOKEN_BUDGET);
      expect(() => budget.reserve(1)).toThrow(LimitExceededError);
      vi.setSystemTime(new Date("2026-03-11T10:00:00Z"));
      expect(() => budget.reserve(1)).not.toThrow();
    });
  });

  describe("reititys ja eval", () => {
    function config(): AppConfig {
      return {
        server: { name: "t", version: "0" },
        provider: { baseUrl: BASE, apiKey: "", timeoutMs: 5000, kind: "litellm" },
        tasks: { general: { model: "primary", fallbackModel: "fallback" } },
        usage: { provider: "litellm", baseUrl: BASE, apiKey: "" },
        eval: { judge: { enabled: false }, pricing: {}, concurrency: 4, allowedModels: ["a", "b", "c"] },
        database: { path: ":memory:" },
      };
    }

    it("route_and_complete: liian suuri maxTokens hylätään eikä käytä varamallia", async () => {
      // Ei interceptejä: yksikin kutsu varamalliin kaataisi testin
      await expect(
        routeAndComplete(config(), { taskType: "general", prompt: "hei", maxTokens: MAX_TOKENS_PER_CALL + 1 }, db),
      ).rejects.toBeInstanceOf(LimitExceededError);
    });

    it("route_and_complete: budjetin ylitys ei laukaise varamallia", async () => {
      createTokenBudget(db).reserve(DAILY_TOKEN_BUDGET);
      const spy = vi.spyOn(db, "reserveTokens");
      await expect(routeAndComplete(config(), { taskType: "general", prompt: "hei" }, db)).rejects.toBeInstanceOf(
        LimitExceededError,
      );
      // Vain päämallin varausyritys; varamallille ei yritetä lainkaan
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("route_and_complete: liian suuri maxTokens ei yritä varausta eikä varamallia lainkaan", async () => {
      const spy = vi.spyOn(db, "reserveTokens");
      await expect(
        routeAndComplete(config(), { taskType: "general", prompt: "hei", maxTokens: MAX_TOKENS_PER_CALL + 1 }, db),
      ).rejects.toBeInstanceOf(LimitExceededError);
      expect(spy).not.toHaveBeenCalled();
    });

    describe("run_eval kutsuraja", () => {
      let dir: string;
      const prompts = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p-${i}`, prompt: `k${i}` }));

      beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "mcp-calls-"));
        writeFileSync(join(dir, "p100.json"), JSON.stringify(prompts(100)));
        writeFileSync(join(dir, "p101.json"), JSON.stringify(prompts(101)));
        writeFileSync(join(dir, "p50.json"), JSON.stringify(prompts(50)));
      });
      afterEach(() => rmSync(dir, { recursive: true, force: true }));

      it("täsmälleen raja (2 mallia x 100 = 200) sallitaan", async () => {
        mockAgent
          .get(BASE)
          .intercept({ path: "/chat/completions", method: "POST" })
          .reply(200, okReply({ total_tokens: 1 }))
          .times(MAX_CALLS_PER_EVAL_RUN);
        const report = await runEval(config(), { promptSetPath: "p100.json", models: ["a", "b"] }, db, { evalDir: dir });
        expect(report.cases).toHaveLength(200);
        expect(report.cases.every((c) => c.error === null)).toBe(true);
      });

      it("raja ylitetty (2 x 101) hylätään ennen yhtäkään kutsua", async () => {
        await expect(
          runEval(config(), { promptSetPath: "p101.json", models: ["a", "b"] }, db, { evalDir: dir }),
        ).rejects.toBeInstanceOf(LimitExceededError);
      });

      it("judge-kutsut lasketaan mukaan (3 x 50 x 2 = 300 hylätään)", async () => {
        const cfg = config();
        cfg.eval.judge = { enabled: true, model: "judge" };
        await expect(
          runEval(cfg, { promptSetPath: "p50.json", models: ["a", "b", "c"] }, db, { evalDir: dir }),
        ).rejects.toBeInstanceOf(LimitExceededError);
      });
    });
  });
});
