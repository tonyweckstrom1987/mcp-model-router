// End-to-end test for examples/routing-demo: spawns the real MCP server over
// stdio, talks to it with the MCP SDK client and checks the routing against a
// local fake provider. No network beyond 127.0.0.1 and no API key.
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// CI builds before `npm test`, so the example runs exactly as a user runs it
// (dist/index.js). Without a build, fall back to the TypeScript source via tsx.
const fromSource = !existsSync("dist/index.js");

describe("examples/routing-demo (e2e over MCP stdio)", () => {
  it("routes each task type to its configured model and falls back on failure", async () => {
    const { runDemo } = await import("../examples/routing-demo/run.mjs");
    const summary = await runDemo({ fromSource });

    expect(summary.tools).toEqual(expect.arrayContaining(["route_and_complete", "list_models", "get_usage", "run_eval"]));
    // list_models reads the fake provider's /models endpoint.
    expect(summary.listModels).toContain("demo/coder");
    expect(summary.listModels).toContain("(litellm /models, 3)");

    const byTask = Object.fromEntries(summary.calls.map((c: { taskType: string }) => [c.taskType, c]));
    expect(byTask.general).toMatchObject({ isError: false, modelsTried: ["demo/fast-cheap"], usedFallback: false });
    expect(byTask.code).toMatchObject({ isError: false, modelsTried: ["demo/coder"], modelUsed: "demo/coder" });
    expect(byTask.writing).toMatchObject({ isError: false, modelsTried: ["demo/writer"] });
    expect(byTask.orchestration).toMatchObject({
      isError: false,
      modelsTried: ["demo/planner-unavailable", "demo/fast-cheap"],
      modelUsed: "demo/fast-cheap",
      usedFallback: true,
    });
    expect(byTask.code.answer).toBe("[demo/coder] fake answer to: Write a function that reverses a string.");
  }, 30_000);

  it("prints a readable report and exits 0 when run as a script", async () => {
    const args = ["examples/routing-demo/run.mjs", ...(fromSource ? ["--from-source"] : [])];
    const { stdout } = await promisify(execFile)(process.execPath, args, { timeout: 30_000 });
    expect(stdout).toContain("orchestration  demo/planner-unavailable -> demo/fast-cheap  (primary failed, fallback used)");
    expect(stdout).toContain("no API key, no cost");
  }, 30_000);
});
