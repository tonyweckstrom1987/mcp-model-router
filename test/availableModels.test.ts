import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { fetchAvailableModels, clearModelsCache } from "../src/models/availableModels.js";
import { createServer } from "../src/server/createServer.js";
import { AppConfigSchema, type AppConfig } from "../src/config/schema.js";

const BASE = "http://litellm.local:4000";

function makeConfig(over: Record<string, unknown> = {}): AppConfig {
  return AppConfigSchema.parse({
    provider: { baseUrl: BASE, apiKey: "testiavain-ei-oikea", ...over },
    tasks: {
      general: { model: "deepseek-flash", fallbackModel: "vanha-malli" },
      code: { model: "qwen-coder" },
    },
    usage: { baseUrl: BASE },
  });
}

describe("mallilista /models-rajapinnasta", () => {
  let mockAgent: MockAgent;
  const originalDispatcher = getGlobalDispatcher();

  beforeEach(() => {
    clearModelsCache();
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
  });
  afterEach(async () => {
    setGlobalDispatcher(originalDispatcher);
    await mockAgent.close();
  });

  const models = (ids: string[], times = 1) =>
    mockAgent
      .get(BASE)
      .intercept({ path: "/models", method: "GET" })
      .reply(200, { data: ids.map((id) => ({ id })) })
      .times(times);

  it("hakee, lajittelee ja poistaa kaksoiskappaleet", async () => {
    models(["b", "a", "b"]);
    const r = await fetchAvailableModels(makeConfig().provider);
    expect(r.ids).toEqual(["a", "b"]);
    expect(r.cached).toBe(false);
  });

  it("lähettää Bearer-avaimen", async () => {
    mockAgent
      .get(BASE)
      .intercept({ path: "/models", method: "GET", headers: { authorization: "Bearer testiavain-ei-oikea" } })
      .reply(200, { data: [{ id: "x" }] });
    expect((await fetchAvailableModels(makeConfig().provider)).ids).toEqual(["x"]);
  });

  it("käyttää välimuistia TTL:n sisällä ja hakee uudelleen sen jälkeen", async () => {
    models(["a"], 2);
    const p = makeConfig({ modelsCacheTtlMs: 1000 }).provider;
    let t = 1000;
    const now = () => t;
    expect((await fetchAvailableModels(p, { now })).cached).toBe(false);
    t += 500;
    expect((await fetchAvailableModels(p, { now })).cached).toBe(true);
    t += 600;
    expect((await fetchAvailableModels(p, { now })).cached).toBe(false);
  });

  it("refresh ohittaa välimuistin", async () => {
    models(["a"], 2);
    const p = makeConfig().provider;
    await fetchAvailableModels(p);
    expect((await fetchAvailableModels(p, { refresh: true })).cached).toBe(false);
  });

  it("virhe ei päädy välimuistiin eikä paljasta vastausrunkoa", async () => {
    mockAgent.get(BASE).intercept({ path: "/models", method: "GET" }).reply(401, { error: "salainen-runko" });
    const p = makeConfig().provider;
    const err = await fetchAvailableModels(p).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("HTTP 401");
    expect((err as Error).message).not.toContain("salainen");
    models(["ok"]);
    expect((await fetchAvailableModels(p)).ids).toEqual(["ok"]);
  });

  it("hylkää vastauksen ilman data-taulukkoa", async () => {
    mockAgent.get(BASE).intercept({ path: "/models", method: "GET" }).reply(200, { foo: 1 });
    await expect(fetchAvailableModels(makeConfig().provider)).rejects.toThrow(/data-taulukko/);
  });

  it("aikakatkaisu antaa selkeän virheen", async () => {
    mockAgent.get(BASE).intercept({ path: "/models", method: "GET" }).reply(200, { data: [] }).delay(300);
    await expect(fetchAvailableModels(makeConfig({ modelsTimeoutMs: 50 }).provider)).rejects.toThrow(/aikakatkaistiin/);
  });

  describe("list_models-työkalu", () => {
    async function call(config: AppConfig, args: Record<string, unknown> = {}) {
      const server = createServer(config);
      const client = new Client({ name: "testi", version: "0" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(a), client.connect(b)]);
      const res = (await client.callTool({ name: "list_models", arguments: args })) as {
        content: Array<{ text: string }>;
        structuredContent: Record<string, any>;
        isError?: boolean;
      };
      await client.close();
      return res;
    }

    it("näyttää palvelimen mallit ja varoittaa puuttuvista config-malleista", async () => {
      models(["deepseek-flash", "qwen-coder", "muu"]);
      const res = await call(makeConfig());
      const text = res.content[0].text;
      expect(text).toContain("Saatavilla olevat mallit");
      expect(text).toContain("- muu");
      expect(text).toMatch(/general: deepseek-flash \(varamalli: vanha-malli\) \[VAROITUS: varamalli ei ole/);
      expect(text).not.toMatch(/code: qwen-coder.*VAROITUS/);
      expect(res.structuredContent.available.models).toEqual(["deepseek-flash", "muu", "qwen-coder"]);
      expect(res.structuredContent.availableError).toBeNull();
    });

    it("varaa config.yaml:n ja näyttää virheen, kun haku epäonnistuu", async () => {
      mockAgent.get(BASE).intercept({ path: "/models", method: "GET" }).reply(500, "x");
      const res = await call(makeConfig());
      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toContain("general: deepseek-flash");
      expect(res.content[0].text).toContain("VAROITUS: mallilistan haku epäonnistui (HTTP 500)");
      expect(res.structuredContent.available).toBeNull();
      expect(res.structuredContent.availableError).toContain("HTTP 500");
      expect(res.content[0].text).not.toContain("litellm.local");
    });

    it("tuntematon taskType antaa virheen hakematta mallilistaa", async () => {
      const res = await call(makeConfig(), { taskType: "ei-ole" });
      expect(res.isError).toBe(true);
    });
  });
});
