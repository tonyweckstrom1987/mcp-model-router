import { describe, it, expect } from "vitest";
import { Db } from "../src/lib/db.js";

describe("Db", () => {
  it("tallentaa ja lukee kutsulokin", () => {
    const db = new Db(":memory:");
    db.insertCallLog({
      taskType: "general",
      modelRequested: "m1",
      modelUsed: "m1",
      usedFallback: false,
      latencyMs: 123,
      status: "ok",
      promptTokens: 5,
      completionTokens: 10,
    });

    const rows = db.listRecentCallLogs(10) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].task_type).toBe("general");
    expect(rows[0].model_used).toBe("m1");
    db.close();
  });

  it("tallentaa eval-ajon ja tulokset run_id:n mukaan", () => {
    const db = new Db(":memory:");
    db.insertEvalRun({ runId: "run-1", promptSetPath: "prompts.json", models: ["m1", "m2"], judgeUsed: false });
    db.insertEvalResult({
      runId: "run-1",
      promptId: "p1",
      model: "m1",
      latencyMs: 100,
      response: "vastaus",
      passed: true,
      judgeScore: null,
      priceUsd: 0.001,
      errorMessage: null,
    });

    const rows = db.getEvalRunResults("run-1") as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].model).toBe("m1");
    expect(rows[0].passed).toBe(1);
    db.close();
  });
});
