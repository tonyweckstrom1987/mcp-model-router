import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { callChatCompletion } from "../src/lib/openaiClient.js";

describe("callChatCompletion", () => {
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

  it("palauttaa vastauksen tekstin ja käytön onnistuneesta kutsusta", async () => {
    const pool = mockAgent.get("http://litellm.local:4000");
    pool
      .intercept({ path: "/chat/completions", method: "POST" })
      .reply(200, {
        model: "test-model",
        choices: [{ message: { content: "Hei maailma" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });

    const result = await callChatCompletion({
      baseUrl: "http://litellm.local:4000",
      model: "test-model",
      messages: [{ role: "user", content: "Hei" }],
    });

    expect(result.text).toBe("Hei maailma");
    expect(result.model).toBe("test-model");
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  });

  it("lähettää Authorization-otsikon kun apiKey annetaan", async () => {
    const pool = mockAgent.get("http://litellm.local:4000");
    pool
      .intercept({
        path: "/chat/completions",
        method: "POST",
        headers: (headers) => headers.authorization === "Bearer salainen-avain",
      })
      .reply(200, { model: "test-model", choices: [{ message: { content: "ok" } }] });

    const result = await callChatCompletion({
      baseUrl: "http://litellm.local:4000",
      apiKey: "salainen-avain",
      model: "test-model",
      messages: [{ role: "user", content: "Hei" }],
    });

    expect(result.text).toBe("ok");
  });

  it("heittää virheen kun rajapinta vastaa ei-2xx-statuksella", async () => {
    const pool = mockAgent.get("http://litellm.local:4000");
    pool
      .intercept({ path: "/chat/completions", method: "POST" })
      .reply(500, "sisäinen virhe");

    await expect(
      callChatCompletion({
        baseUrl: "http://litellm.local:4000",
        model: "test-model",
        messages: [{ role: "user", content: "Hei" }],
      }),
    ).rejects.toThrow(/500/);
  });
});
