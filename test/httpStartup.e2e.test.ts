// Starts the real CLI (src/index.ts via tsx) in HTTP mode and checks the
// startup rule for DNS rebinding protection: the exit code and stderr.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const workDir = mkdtempSync(join(tmpdir(), "mcp-router-startup-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

interface Run {
  code: number | null;
  stderr: string;
  listened: boolean;
}

// Resolves when the process exits, or kills it once it prints the listening line.
function runCli(host: string, allowedHosts?: string): Promise<Run> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    CONFIG_PATH: join("examples", "routing-demo", "demo-config.yaml"),
    DB_PATH: join(workDir, `${host.replace(/[^a-z0-9]/gi, "_")}-${allowedHosts ? "a" : "n"}.sqlite`),
    MCP_TRANSPORT: "http",
    MCP_HTTP_HOST: host,
    MCP_HTTP_PORT: "0",
    MCP_AUTH_TOKEN: "s".repeat(40),
  };
  if (allowedHosts !== undefined) env.MCP_ALLOWED_HOSTS = allowedHosts;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", join("src", "index.ts")], { env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let listened = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (!listened && stderr.includes("/mcp")) {
        listened = true;
        child.kill("SIGTERM");
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr, listened });
    });
  });
}

describe("CLI startup: DNS rebinding protection in HTTP mode", () => {
  it("127.0.0.1 without MCP_ALLOWED_HOSTS starts", async () => {
    const run = await runCli("127.0.0.1");
    expect(run.listened).toBe(true);
    expect(run.stderr).not.toContain("DNS rebinding");
  }, 30_000);

  it("0.0.0.0 without MCP_ALLOWED_HOSTS exits non-zero with a clear message", async () => {
    const run = await runCli("0.0.0.0");
    expect(run.listened).toBe(false);
    expect(run.code).not.toBe(0);
    expect(run.code).not.toBeNull();
    expect(run.stderr).toContain("MCP_HTTP_HOST is 0.0.0.0");
    expect(run.stderr).toContain("Set MCP_ALLOWED_HOSTS");
    // Printed as a plain message, not a stack trace.
    expect(run.stderr).not.toMatch(/\bat\s+\S+\s+\(/);
  }, 30_000);

  it("0.0.0.0 with MCP_ALLOWED_HOSTS starts", async () => {
    const run = await runCli("0.0.0.0", "127.0.0.1, my-host.tailnet.ts.net");
    expect(run.listened).toBe(true);
  }, 30_000);
});
