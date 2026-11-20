import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { callChatCompletion, redactSecret } from "../src/lib/openaiClient.js";
import { fetchUsage } from "../src/usage/usageProviders.js";
import { budgetFor } from "../src/lib/budget.js";
import { Db } from "../src/lib/db.js";

const KEY = "sk-litellm-0123456789abcdef";

describe("API key does not end up in error messages", () => {
  let mockAgent: MockAgent;
  const originalDispatcher = getGlobalDispatcher();

  beforeEach(() => {
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
  });

  afterEach(async () => {
    setGlobalDispatcher(originalDispatcher);
    await mockAgent.close();
  });

  it("redacts the key when a model call error body echoes it", async () => {
    mockAgent
      .get("http://litellm.local:4000")
      .intercept({ path: "/chat/completions", method: "POST" })
      .reply(401, `{"error":"Invalid API key: ${KEY}"}`);

    const err = await callChatCompletion({
      baseUrl: "http://litellm.local:4000",
      apiKey: KEY,
      budget: budgetFor(new Db(":memory:")),
      model: "m",
      messages: [{ role: "user", content: "Hello" }],
    }).catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("401");
    expect((err as Error).message).toContain("***");
    expect((err as Error).message).not.toContain(KEY);
  });

  it("does not leak part of the key at the 500 character cut", async () => {
    const body = "x".repeat(490) + KEY;
    mockAgent
      .get("http://litellm.local:4000")
      .intercept({ path: "/chat/completions", method: "POST" })
      .reply(500, body);

    const err = await callChatCompletion({
      baseUrl: "http://litellm.local:4000",
      apiKey: KEY,
      budget: budgetFor(new Db(":memory:")),
      model: "m",
      messages: [{ role: "user", content: "Hello" }],
    }).catch((e: Error) => e);

    expect((err as Error).message).not.toContain(KEY.slice(0, 10));
  });

  it("redacts the key when a usage endpoint error body echoes it", async () => {
    mockAgent
      .get("http://litellm.local:4000")
      .intercept({ path: "/user/info", method: "GET" })
      .reply(403, `forbidden for key ${KEY}`);

    const err = await fetchUsage({ provider: "litellm", baseUrl: "http://litellm.local:4000", apiKey: KEY }).catch(
      (e: Error) => e,
    );

    expect((err as Error).message).toContain("403");
    expect((err as Error).message).not.toContain(KEY);
  });
});

describe("redactSecret", () => {
  it("replaces every occurrence", () => {
    expect(redactSecret(`a ${KEY} b ${KEY}`, KEY)).toBe("a *** b ***");
  });

  it("leaves text unchanged when the key is missing or shorter than 8 characters", () => {
    expect(redactSecret("abc def", undefined)).toBe("abc def");
    expect(redactSecret("abc def", "")).toBe("abc def");
    expect(redactSecret("abc def", "abc")).toBe("abc def");
  });
});
