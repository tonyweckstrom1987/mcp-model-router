import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { Db } from "../src/lib/db.js";
import { createTokenBudget } from "../src/lib/budget.js";
import { callChatCompletion, usageToSettle } from "../src/lib/openaiClient.js";
import { budgetDay } from "../src/lib/limits.js";

const BASE = "http://litellm.local:4000";

describe("settling the reservation from usage", () => {
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

  /** Makes one call with the given usage and returns the tokens reserved for the day afterwards. */
  async function reservedAfter(usage: unknown): Promise<number> {
    mockAgent
      .get(BASE)
      .intercept({ path: "/chat/completions", method: "POST" })
      .reply(200, { model: "m", choices: [{ message: { content: "ok" } }], usage });
    await callChatCompletion({
      baseUrl: BASE,
      model: "m",
      messages: [{ role: "user", content: "Hey" }],
      maxTokens: 100,
      budget: createTokenBudget(db),
    });
    return db.getReservedTokens(budgetDay(new Date()));
  }

  // Estimate: ceil(3/3) + 4 = 5 input tokens + maxTokens 100.
  const FULL_RESERVATION = 105;

  it.each([
    ["empty usage", {}],
    ["null fields", { prompt_tokens: null, completion_tokens: null, total_tokens: null }],
    ["zeros", { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }],
    ["total 0 only", { total_tokens: 0 }],
    ["completion only", { completion_tokens: 3 }],
    ["prompt only", { prompt_tokens: 3 }],
    ["strings", { prompt_tokens: "1", completion_tokens: "2" }],
    ["negative total", { total_tokens: -5 }],
  ])("%s: usage is unknown, so the reservation stays", async (_name, usage) => {
    expect(await reservedAfter(usage)).toBe(FULL_RESERVATION);
  });

  it("total_tokens settles the reservation", async () => {
    expect(await reservedAfter({ total_tokens: 7 })).toBe(7);
  });

  it("prompt + completion settles the reservation when total is missing", async () => {
    expect(await reservedAfter({ prompt_tokens: 2, completion_tokens: 3 })).toBe(5);
  });

  it("a non-zero sum is accepted even if one part is 0", async () => {
    expect(await reservedAfter({ prompt_tokens: 4, completion_tokens: 0 })).toBe(4);
  });

  it("an unusable total does not prevent summing the parts", () => {
    expect(usageToSettle({ totalTokens: 0, promptTokens: 2, completionTokens: 3 })).toBe(5);
  });

  it("usage missing entirely: undefined", () => {
    expect(usageToSettle(undefined)).toBeUndefined();
  });
});
