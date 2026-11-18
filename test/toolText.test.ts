import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server/createServer.js";
import { AppConfigSchema } from "../src/config/schema.js";

// MCP clients (and the LLMs behind them) read tool titles and descriptions, so
// they must be in English like the README and the npm package.
const FINNISH_LETTERS = /[äöåÄÖÅ]/;

describe("tool metadata is in English", () => {
  it("titles, descriptions and input descriptions contain no Finnish letters", async () => {
    const config = AppConfigSchema.parse({
      provider: { baseUrl: "http://litellm.local:4000", apiKey: "test-key-not-real" },
      tasks: { general: { model: "m" } },
      usage: { baseUrl: "http://litellm.local:4000" },
    });
    const server = createServer(config);
    const client = new Client({ name: "test", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    await client.close();

    expect(tools.map((t) => t.name).sort()).toEqual(["get_usage", "list_models", "route_and_complete", "run_eval"]);
    const texts: string[] = [];
    for (const t of tools) {
      texts.push(t.title ?? "", t.description ?? "");
      const props = (t.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
      for (const p of Object.values(props)) texts.push(p.description ?? "");
    }
    const finnish = texts.filter((s) => FINNISH_LETTERS.test(s));
    expect(finnish).toEqual([]);
    expect(texts.filter((s) => s === "").length).toBe(0);
  });
});
