import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { routeAndComplete } from "../src/router/routeAndComplete.js";
import { Db } from "../src/lib/db.js";
import { logCallSafely, logEvalResultSafely } from "../src/lib/safeLog.js";
import type { AppConfig } from "../src/config/schema.js";

function config(): AppConfig {
  return {
    server: { name: "test", version: "0.0.0" },
    provider: { baseUrl: "http://litellm.local:4000", apiKey: "", timeoutMs: 5000, kind: "litellm" },
    tasks: { general: { model: "primary-model", fallbackModel: "fallback-model" } },
    usage: { provider: "litellm", baseUrl: "http://litellm.local:4000", apiKey: "" },
    eval: { judge: { enabled: false }, pricing: {} },
    database: { path: ":memory:" },
  };
}

function rikkinainenKanta(): Db {
  const db = new Db(":memory:");
  db.insertCallLog = () => {
    throw new Error("SQLITE_READONLY: attempt to write a readonly database");
  };
  db.insertEvalResult = () => {
    throw new Error("SQLITE_FULL: database or disk is full");
  };
  return db;
}

describe("kirjausvirhe ei muuta mallikutsun tulosta (katselmointi 28.10., löydökset 1 ja 4)", () => {
  let mockAgent: MockAgent;
  const original = getGlobalDispatcher();
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
    stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(async () => {
    stderr.mockRestore();
    setGlobalDispatcher(original);
    await mockAgent.close();
  });

  it("päämallin onnistuminen palautetaan, eikä varamallia kutsuta, vaikka kirjaus heittää", async () => {
    const pool = mockAgent.get("http://litellm.local:4000");
    let kutsuja = 0;
    pool
      .intercept({ path: "/chat/completions", method: "POST" })
      .reply(200, () => {
        kutsuja++;
        return { model: "primary-model", choices: [{ message: { content: "vastaus" } }] };
      })
      .persist();

    const r = await routeAndComplete(config(), { taskType: "general", prompt: "hei" }, rikkinainenKanta());

    expect(r.usedFallback).toBe(false);
    expect(r.modelUsed).toBe("primary-model");
    expect(r.text).toBe("vastaus");
    expect(kutsuja).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("kutsulokin kirjaus epäonnistui (Error): SQLITE_READONLY"));
  });

  it("apufunktiot eivät heitä eivätkä kirjoita stdoutiin", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const db = rikkinainenKanta();
      expect(() =>
        logCallSafely(db, { taskType: "t", modelRequested: "m", modelUsed: "m", usedFallback: false, latencyMs: 1, status: "ok" }),
      ).not.toThrow();
      expect(() =>
        logEvalResultSafely(db, {
          runId: "r", promptId: "p", model: "m", latencyMs: 1, response: "", passed: null,
          judgeScore: null, priceUsd: null, errorMessage: null,
        }),
      ).not.toThrow();
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("eval-tuloksen kirjaus epäonnistui"));
    } finally {
      stdout.mockRestore();
    }
  });

  it("ilman kantaa ei tehdä mitään", () => {
    expect(() =>
      logCallSafely(undefined, { taskType: "t", modelRequested: "m", modelUsed: "m", usedFallback: false, latencyMs: 1, status: "ok" }),
    ).not.toThrow();
    expect(stderr).not.toHaveBeenCalled();
  });
});
