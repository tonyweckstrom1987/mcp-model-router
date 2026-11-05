import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { Db } from "../src/lib/db.js";
import { createTokenBudget } from "../src/lib/budget.js";
import { callChatCompletion, usageToSettle } from "../src/lib/openaiClient.js";
import { budgetDay } from "../src/lib/limits.js";

const BASE = "http://litellm.local:4000";

describe("varauksen korjaus usage-kentästä", () => {
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

  /** Tekee yhden kutsun annetulla usagella ja palauttaa päivän varatut tokenit sen jälkeen. */
  async function reservedAfter(usage: unknown): Promise<number> {
    mockAgent
      .get(BASE)
      .intercept({ path: "/chat/completions", method: "POST" })
      .reply(200, { model: "m", choices: [{ message: { content: "ok" } }], usage });
    await callChatCompletion({
      baseUrl: BASE,
      model: "m",
      messages: [{ role: "user", content: "Hei" }],
      maxTokens: 100,
      budget: createTokenBudget(db),
    });
    return db.getReservedTokens(budgetDay(new Date()));
  }

  // Arvio: ceil(3/3) + 4 = 5 syötetokenia + maxTokens 100.
  const FULL_RESERVATION = 105;

  it.each([
    ["tyhjä usage", {}],
    ["null-kentät", { prompt_tokens: null, completion_tokens: null, total_tokens: null }],
    ["nollat", { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }],
    ["pelkkä total 0", { total_tokens: 0 }],
    ["pelkkä completion", { completion_tokens: 3 }],
    ["pelkkä prompt", { prompt_tokens: 3 }],
    ["merkkijonot", { prompt_tokens: "1", completion_tokens: "2" }],
    ["negatiivinen total", { total_tokens: -5 }],
  ])("%s: käyttöä ei tiedetä, joten varaus jää voimaan", async (_nimi, usage) => {
    expect(await reservedAfter(usage)).toBe(FULL_RESERVATION);
  });

  it("total_tokens korjaa varauksen", async () => {
    expect(await reservedAfter({ total_tokens: 7 })).toBe(7);
  });

  it("prompt + completion korjaa varauksen, kun total puuttuu", async () => {
    expect(await reservedAfter({ prompt_tokens: 2, completion_tokens: 3 })).toBe(5);
  });

  it("nollasta poikkeava summa kelpaa, vaikka toinen osa on 0", async () => {
    expect(await reservedAfter({ prompt_tokens: 4, completion_tokens: 0 })).toBe(4);
  });

  it("käyttökelvoton total ei estä laskemasta osista", () => {
    expect(usageToSettle({ totalTokens: 0, promptTokens: 2, completionTokens: 3 })).toBe(5);
  });

  it("usage puuttuu kokonaan: undefined", () => {
    expect(usageToSettle(undefined)).toBeUndefined();
  });
});
