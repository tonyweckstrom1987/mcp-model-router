import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { routeAndComplete } from "../src/router/routeAndComplete.js";
import { Db } from "../src/lib/db.js";
import type { AppConfig } from "../src/config/schema.js";

function baseConfig(): AppConfig {
  return {
    server: { name: "test", version: "0.0.0" },
    provider: { baseUrl: "http://litellm.local:4000", apiKey: "", timeoutMs: 5000, kind: "litellm" },
    tasks: {
      general: { model: "primary-model", fallbackModel: "fallback-model" },
      code: { model: "code-model" },
    },
    usage: { provider: "litellm", baseUrl: "http://litellm.local:4000", apiKey: "" },
    eval: { judge: { enabled: false }, pricing: {} },
    database: { path: ":memory:" },
  };
}

describe("routeAndComplete", () => {
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

  it("kutsuu päämallia ja palauttaa vastauksen kun se onnistuu", async () => {
    const pool = mockAgent.get("http://litellm.local:4000");
    pool
      .intercept({ path: "/chat/completions", method: "POST" })
      .reply(200, { model: "primary-model", choices: [{ message: { content: "vastaus" } }] });

    const result = await routeAndComplete(baseConfig(), { taskType: "general", prompt: "moi" });

    expect(result.usedFallback).toBe(false);
    expect(result.modelUsed).toBe("primary-model");
    expect(result.text).toBe("vastaus");
  });

  it("siirtyy varamalliin kun päämalli epäonnistuu", async () => {
    const pool = mockAgent.get("http://litellm.local:4000");
    pool.intercept({ path: "/chat/completions", method: "POST" }).reply(500, "virhe");
    pool
      .intercept({ path: "/chat/completions", method: "POST" })
      .reply(200, { model: "fallback-model", choices: [{ message: { content: "varavastaus" } }] });

    const result = await routeAndComplete(baseConfig(), { taskType: "general", prompt: "moi" });

    expect(result.usedFallback).toBe(true);
    expect(result.modelUsed).toBe("fallback-model");
    expect(result.text).toBe("varavastaus");
    expect(result.primaryError).toMatch(/500/);
  });

  it("heittää virheen kun päämalli epäonnistuu eikä varamallia ole", async () => {
    const pool = mockAgent.get("http://litellm.local:4000");
    pool.intercept({ path: "/chat/completions", method: "POST" }).reply(500, "virhe");

    await expect(routeAndComplete(baseConfig(), { taskType: "code", prompt: "moi" })).rejects.toThrow(/500/);
  });

  it("heittää virheen tuntemattomasta tehtävätyypistä", async () => {
    await expect(routeAndComplete(baseConfig(), { taskType: "ei-olemassa", prompt: "moi" })).rejects.toThrow(
      /Tuntematon tehtävätyyppi/,
    );
  });

  it("karsii openrouter/-etuliitteen mallitunnisteesta kun provider.kind on openrouter", async () => {
    const config = baseConfig();
    config.provider.kind = "openrouter";
    config.tasks.general = { model: "openrouter/deepseek/deepseek-v4.1-flash" };

    const pool = mockAgent.get("http://litellm.local:4000");
    pool
      .intercept({
        path: "/chat/completions",
        method: "POST",
        body: (body) => JSON.parse(body).model === "deepseek/deepseek-v4.1-flash",
      })
      .reply(200, { model: "deepseek/deepseek-v4.1-flash", choices: [{ message: { content: "vastaus" } }] });

    const result = await routeAndComplete(config, { taskType: "general", prompt: "moi" });

    expect(result.text).toBe("vastaus");
  });

  it("kirjoittaa kutsulokin oikeaan tietokantaan", async () => {
    const pool = mockAgent.get("http://litellm.local:4000");
    pool
      .intercept({ path: "/chat/completions", method: "POST" })
      .reply(200, { model: "primary-model", choices: [{ message: { content: "vastaus" } }] });

    const db = new Db(":memory:");
    await routeAndComplete(baseConfig(), { taskType: "general", prompt: "moi" }, db);

    const rows = db.listRecentCallLogs(10) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].model_used).toBe("primary-model");
    db.close();
  });
});
