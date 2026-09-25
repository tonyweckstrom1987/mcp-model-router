import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { fetchUsage } from "../src/usage/usageProviders.js";

describe("fetchUsage", () => {
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

  it("lukee LiteLLM:n /user/info-vastauksen", async () => {
    const pool = mockAgent.get("http://litellm.local:4000");
    pool
      .intercept({ path: "/user/info", method: "GET" })
      .reply(200, { user_info: { spend: 12.5, max_budget: 100 } });

    const snapshot = await fetchUsage({ provider: "litellm", baseUrl: "http://litellm.local:4000", apiKey: "" });

    expect(snapshot.provider).toBe("litellm");
    expect(snapshot.summary.spendUsd).toBe(12.5);
    expect(snapshot.summary.budgetUsd).toBe(100);
    expect(snapshot.summary.remainingUsd).toBe(87.5);
  });

  it("lukee OpenRouterin /credits-vastauksen", async () => {
    const pool = mockAgent.get("https://openrouter.ai");
    pool
      .intercept({ path: "/credits", method: "GET" })
      .reply(200, { data: { total_credits: 50, total_usage: 10 } });

    const snapshot = await fetchUsage({ provider: "openrouter", baseUrl: "https://openrouter.ai", apiKey: "" });

    expect(snapshot.provider).toBe("openrouter");
    expect(snapshot.summary.spendUsd).toBe(10);
    expect(snapshot.summary.budgetUsd).toBe(50);
    expect(snapshot.summary.remainingUsd).toBe(40);
  });

  it("heittää virheen kun rajapinta vastaa virheellä", async () => {
    const pool = mockAgent.get("http://litellm.local:4000");
    pool.intercept({ path: "/user/info", method: "GET" }).reply(401, "unauthorized");

    await expect(
      fetchUsage({ provider: "litellm", baseUrl: "http://litellm.local:4000", apiKey: "" }),
    ).rejects.toThrow(/401/);
  });
});
