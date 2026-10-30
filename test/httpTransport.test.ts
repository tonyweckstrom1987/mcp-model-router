import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { startHttpTransport } from "../src/transport/http.js";

const TOKEN = "h".repeat(32) + "-http-transport-test";
const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
};

async function start(factory: () => McpServer): Promise<{ server: Server; base: string; port: number }> {
  const server = startHttpTransport(factory, { host: "127.0.0.1", port: 0, authToken: TOKEN });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, base: `http://127.0.0.1:${port}`, port };
}

function stop(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function postRaw(base: string, body: string, headers: Record<string, string> = {}) {
  return fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body,
  });
}

describe("HTTP: tunnistus ennen JSON-jäsennystä (katselmointi 28.10., löydös 9)", () => {
  let server: Server;
  let base: string;
  let port: number;

  beforeAll(async () => {
    ({ server, base, port } = await start(() => new McpServer({ name: "t", version: "0" })));
  });
  afterAll(() => stop(server));

  it("tunnistamaton pyyntö virheellisellä JSONilla -> 401, ei jäsennysvirhettä eikä pinojälkeä", async () => {
    const res = await postRaw(base, "{");
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toMatch(/SyntaxError|JSON|\bat\s+\S+\s+\(/);
  });

  it("tunnistamaton liian suuri body -> 401 eikä 413 (bodya ei lueta)", async () => {
    const res = await postRaw(base, JSON.stringify({ x: "a".repeat(200_000) }));
    expect(res.status).toBe(401);
  });

  it("tunnistettu pyyntö virheellisellä JSONilla -> 400 JSON-RPC parse error ilman pinojälkeä", async () => {
    const res = await postRaw(base, "{", { authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
    expect(text).not.toMatch(/SyntaxError|\bat\s+\S+\s+\(/);
  });

  it("tunnistettu kelvollinen pyyntö -> 200", async () => {
    const res = await postRaw(base, JSON.stringify(INIT), { authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(200);
  });

  it("DNS rebinding -suoja säilyy: vieras Host-otsake -> 403 ennen tunnistusta", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { host: "evil.example", "content-type": "application/json" } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify(INIT));
    });
    expect(status).toBe(403);
  });
});

describe("HTTP: palvelin ja transport suljetaan kaikilla poluilla (löydös 8)", () => {
  it("onnistunut pyyntö sulkee palvelininstanssin", async () => {
    const instances: McpServer[] = [];
    const { server, base } = await start(() => {
      const s = new McpServer({ name: "t", version: "0" });
      vi.spyOn(s, "close");
      instances.push(s);
      return s;
    });
    try {
      const res = await postRaw(base, JSON.stringify(INIT), { authorization: `Bearer ${TOKEN}` });
      expect(res.status).toBe(200);
      await res.text();
      await vi.waitFor(() => expect(instances[0].close).toHaveBeenCalled());
    } finally {
      await stop(server);
    }
  });

  it("connect-virhe -> 500 ja palvelininstanssi suljetaan silti", async () => {
    const instances: McpServer[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { server, base } = await start(() => {
      const s = new McpServer({ name: "t", version: "0" });
      vi.spyOn(s, "connect").mockRejectedValue(new Error("boom"));
      vi.spyOn(s, "close");
      instances.push(s);
      return s;
    });
    try {
      const res = await postRaw(base, JSON.stringify(INIT), { authorization: `Bearer ${TOKEN}` });
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).not.toContain("boom");
      await vi.waitFor(() => expect(instances[0].close).toHaveBeenCalled());
    } finally {
      errSpy.mockRestore();
      await stop(server);
    }
  });
});
