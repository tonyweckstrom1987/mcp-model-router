#!/usr/bin/env node
// Routing demo: runs mcp-model-router as a real MCP server (stdio) against a
// local fake provider and shows which model each task type is routed to.
// No API key, no network access beyond 127.0.0.1, nothing is paid for.
//
//   npm run build && npm run example
//
// Options:
//   --json         print the result as JSON (used by the end-to-end test)
//   --from-source  run src/index.ts through tsx instead of dist/index.js
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startFakeProvider } from "./fake-provider.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

// One request per task type. The router picks the model from config.yaml.
export const DEMO_REQUESTS = [
  { taskType: "general", prompt: "What is the capital of Finland?" },
  { taskType: "code", prompt: "Write a function that reverses a string." },
  { taskType: "writing", prompt: "Summarise the README in one sentence." },
  { taskType: "orchestration", prompt: "Split 'ship v1.0' into three steps." },
];

function serverCommand(fromSource) {
  if (fromSource) {
    return { command: process.execPath, args: ["--import", "tsx", join(repoRoot, "src", "index.ts")] };
  }
  const entry = join(repoRoot, "dist", "index.js");
  if (!existsSync(entry)) {
    throw new Error("dist/index.js not found: run `npm run build` first (or use --from-source)");
  }
  return { command: process.execPath, args: [entry] };
}

function textOf(result) {
  return (result.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");
}

/** Runs the demo and returns a summary object. Cleans up after itself. */
export async function runDemo({ fromSource = false } = {}) {
  // Resolve the server command first: if it throws, nothing has been started yet.
  const { command, args } = serverCommand(fromSource);
  const provider = await startFakeProvider();
  const workDir = mkdtempSync(join(tmpdir(), "mcp-router-demo-"));
  const transport = new StdioClientTransport({
    command,
    args,
    cwd: repoRoot,
    // Only the variables the server needs: no LLM_API_KEY is passed on.
    env: {
      PATH: process.env.PATH ?? "",
      CONFIG_PATH: join(here, "demo-config.yaml"),
      LLM_BASE_URL: provider.baseUrl,
      DB_PATH: join(workDir, "demo.sqlite"),
      MCP_TRANSPORT: "stdio",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "routing-demo", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    const listModels = textOf(await client.callTool({ name: "list_models", arguments: {} }));
    const calls = [];
    for (const req of DEMO_REQUESTS) {
      const before = provider.requests.length;
      const result = await client.callTool({ name: "route_and_complete", arguments: req });
      const text = textOf(result);
      const [answer, meta = ""] = text.split("\n---\n");
      calls.push({
        taskType: req.taskType,
        isError: Boolean(result.isError),
        modelsTried: provider.requests.slice(before),
        modelUsed: /model: (\S+)/.exec(meta)?.[1] ?? null,
        usedFallback: meta.includes("(fallback used)"),
        answer: answer.trim(),
      });
    }
    return { tools, listModels, calls };
  } finally {
    await client.close().catch(() => {});
    await provider.close();
    rmSync(workDir, { recursive: true, force: true });
  }
}

function printReport({ tools, calls }) {
  console.log(`Connected to mcp-model-router over stdio. Tools: ${tools.join(", ")}\n`);
  console.log("Routing (rules from examples/routing-demo/demo-config.yaml):\n");
  const w = Math.max(...calls.map((c) => c.taskType.length));
  for (const c of calls) {
    const route = c.modelsTried.join(" -> ");
    const note = c.usedFallback ? "  (primary failed, fallback used)" : "";
    console.log(`  ${c.taskType.padEnd(w)}  ${route}${note}`);
    console.log(`  ${" ".repeat(w)}  ${c.isError ? "ERROR: " : ""}${c.answer}\n`);
  }
  console.log("All answers came from a local fake provider: no API key, no cost.");
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  runDemo({ fromSource: argv.includes("--from-source") })
    .then((summary) => {
      if (argv.includes("--json")) console.log(JSON.stringify(summary, null, 2));
      else printReport(summary);
      if (summary.calls.some((c) => c.isError)) process.exitCode = 1;
    })
    .catch((err) => {
      console.error(`routing demo failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
}
