import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { startHttpTransport } from "../src/transport/http.js";
import { assertValidAuthToken, tokensMatch } from "../src/transport/auth.js";

const TOKEN = "t".repeat(16) + "k".repeat(16) + "-secret-for-tests";
const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
};

describe("Bearer-tunnistus /mcp-päätepisteelle", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = startHttpTransport(() => new McpServer({ name: "t", version: "0" }), {
      host: "127.0.0.1",
      port: 0,
      authToken: TOKEN,
    });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function post(headers: Record<string, string>) {
    return fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify(INIT),
    });
  }

  it("ei Authorization-otsaketta -> 401", async () => {
    const res = await post({});
    expect(res.status).toBe(401);
  });

  it("väärä skeema -> 401", async () => {
    expect((await post({ authorization: `Basic ${TOKEN}` })).status).toBe(401);
    expect((await post({ authorization: TOKEN })).status).toBe(401);
  });

  it("väärä token (sama ja eri pituus) -> 401", async () => {
    expect((await post({ authorization: `Bearer ${TOKEN.slice(0, -1)}x` })).status).toBe(401);
    expect((await post({ authorization: `Bearer ${TOKEN}extra` })).status).toBe(401);
    expect((await post({ authorization: "Bearer x" })).status).toBe(401);
    expect((await post({ authorization: "Bearer " })).status).toBe(401);
  });

  it("401-vastaus on sama kaikissa tapauksissa eikä paljasta syytä tai tokenia", async () => {
    const a = await post({});
    const b = await post({ authorization: "Bearer wrong" });
    const bodyA = await a.text();
    const bodyB = await b.text();
    expect(bodyA).toBe(bodyB);
    expect(bodyA).not.toContain(TOKEN);
  });

  it("oikea token -> pyyntö pääsee MCP-käsittelyyn", async () => {
    const res = await post({ authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(200);
  });

  it("GET ja DELETE /mcp vaativat myös tokenin", async () => {
    expect((await fetch(`${base}/mcp`, { method: "GET" })).status).toBe(401);
    expect((await fetch(`${base}/mcp`, { method: "DELETE" })).status).toBe(401);
  });

  it("/healthz pysyy avoimena", async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });
});

describe("tokenin konfigurointi (fail closed)", () => {
  it("palvelin ei käynnisty ilman tokenia", () => {
    expect(() =>
      startHttpTransport(() => new McpServer({ name: "t", version: "0" }), { host: "127.0.0.1", port: 0, authToken: undefined }),
    ).toThrow(/MCP_AUTH_TOKEN/);
  });

  it("palvelin ei käynnisty tyhjällä tai liian lyhyellä (<32) tokenilla", () => {
    for (const bad of ["", "short", "x".repeat(31)]) {
      expect(() =>
        startHttpTransport(() => new McpServer({ name: "t", version: "0" }), { host: "127.0.0.1", port: 0, authToken: bad }),
      ).toThrow(/MCP_AUTH_TOKEN/);
    }
  });

  it("32 merkin token kelpaa", () => {
    expect(assertValidAuthToken("x".repeat(32))).toHaveLength(32);
  });

  it("virheilmoitus ei sisällä tokenia", () => {
    try {
      assertValidAuthToken("secretsecret");
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain("secretsecret");
    }
  });

  it("tokensMatch toimii eri pituuksilla heittämättä", () => {
    expect(tokensMatch("a", "abcdef")).toBe(false);
    expect(tokensMatch("abc", "abc")).toBe(true);
  });
});
