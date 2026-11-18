import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../config/schema.js";
import type { Db } from "../lib/db.js";
import { routeAndComplete } from "../router/routeAndComplete.js";
import { fetchUsage } from "../usage/usageProviders.js";
import { fetchAvailableModels } from "../models/availableModels.js";
import { resolveModelId } from "../lib/modelId.js";
import { runEval } from "../eval/runEval.js";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Rakentaa MCP-palvelimen ja rekisteröi neljä työkalua:
 * route_and_complete, list_models, get_usage, run_eval.
 * Sama palvelininstanssi toimii sekä stdio- että HTTP-siirtotavan kanssa.
 */
export function createServer(config: AppConfig, db?: Db): McpServer {
  const server = new McpServer({
    name: config.server.name,
    version: config.server.version,
  });

  server.registerTool(
    "route_and_complete",
    {
      title: "Route and complete",
      description:
        "Picks a model for the task type from config.yaml and calls it through an OpenAI-compatible API " +
        "(LiteLLM proxy or OpenRouter). Uses the fallback model if the primary model fails.",
      inputSchema: {
        taskType: z
          .string()
          .min(1)
          .describe("Task type, one of the 'tasks' keys in config.yaml, e.g. 'general', 'code', 'writing' or 'orchestration'"),
        prompt: z.string().min(1).describe("User message (prompt) for the model"),
        systemPrompt: z.string().optional().describe("Optional system prompt; overrides the default from config.yaml"),
        temperature: z.number().min(0).max(2).optional().describe("Optional temperature"),
        maxTokens: z.number().int().positive().optional().describe("Optional max_tokens limit for the answer"),
      },
    },
    async (input) => {
      try {
        const result = await routeAndComplete(config, input, db);
        const metaLines = [
          `model: ${result.modelUsed}${result.usedFallback ? " (fallback used)" : ""}`,
          `latency: ${result.latencyMs} ms`,
        ];
        if (result.usage?.totalTokens !== undefined) {
          metaLines.push(`tokens: ${result.usage.totalTokens}`);
        }
        if (result.primaryError) {
          metaLines.push(`primary model error: ${result.primaryError}`);
        }
        return {
          content: [
            { type: "text" as const, text: result.text },
            { type: "text" as const, text: `\n---\n${metaLines.join(" | ")}` },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `route_and_complete failed: ${errorMessage(err)}` }],
        };
      }
    },
  );

  server.registerTool(
    "list_models",
    {
      title: "List models",
      description:
        "Lists the task types in config.yaml with their primary and fallback models, and the models the server " +
        "really offers according to its /models endpoint (cached). If the fetch fails, shows only config.yaml and the error.",
      inputSchema: {
        taskType: z.string().optional().describe("Optional filter: show only the routing for this task type"),
        refresh: z.boolean().optional().describe("Skip the cache and fetch the model list again (default false)"),
      },
    },
    async ({ taskType, refresh }) => {
      const entries = Object.entries(config.tasks).filter(([key]) => !taskType || key === taskType);
      if (entries.length === 0) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Task type '${taskType}' not found in config.yaml.` }],
        };
      }

      let available: Awaited<ReturnType<typeof fetchAvailableModels>> | undefined;
      let fetchError: string | undefined;
      try {
        available = await fetchAvailableModels(config.provider, { refresh });
      } catch (err) {
        fetchError = errorMessage(err);
      }
      const ids = available ? new Set(available.ids) : undefined;
      const missing = (model: string): boolean => (ids ? !ids.has(resolveModelId(config.provider, model)) : false);

      const lines = entries.map(([task, route]) => {
        const notes = [
          missing(route.model) ? `primary model is not in the server's list` : "",
          route.fallbackModel && missing(route.fallbackModel) ? `fallback model is not in the server's list` : "",
        ].filter(Boolean);
        return (
          `- ${task}: ${route.model}${route.fallbackModel ? ` (fallback: ${route.fallbackModel})` : ""}` +
          (notes.length ? ` [WARNING: ${notes.join(", ")}]` : "")
        );
      });
      const text = [`Models per task type (config.yaml):\n${lines.join("\n")}`];
      if (available) {
        text.push(
          `\nAvailable models (${config.provider.kind} /models, ${available.ids.length}${available.cached ? ", cached" : ""}):\n` +
            (available.ids.length ? available.ids.map((id) => `- ${id}`).join("\n") : "(the list is empty)"),
        );
      } else {
        text.push(`\nWARNING: ${fetchError}. Showing only the models from config.yaml; they may differ from what the server really offers.`);
      }
      return {
        content: [{ type: "text" as const, text: text.join("\n") }],
        structuredContent: {
          tasks: Object.fromEntries(entries.map(([task, route]) => [task, route])),
          available: available ? { models: available.ids, cached: available.cached } : null,
          availableError: fetchError ?? null,
        },
      };
    },
  );

  server.registerTool(
    "get_usage",
    {
      title: "Show usage and budget",
      description:
        "Reads spend and budget from the LiteLLM or OpenRouter API (config.yaml: usage.provider). " +
        "Keeps no spend ledger of its own.",
      inputSchema: {
        includeRaw: z.boolean().optional().describe("Include the raw JSON response from the API (default false)"),
      },
    },
    async ({ includeRaw }) => {
      try {
        const snapshot = await fetchUsage(config.usage);
        const s = snapshot.summary;
        const lines = [
          `source: ${snapshot.provider}`,
          `spend: ${s.spendUsd === null ? "not available" : `${s.spendUsd.toFixed(4)} USD`}`,
          `budget: ${s.budgetUsd === null ? "not available" : `${s.budgetUsd.toFixed(4)} USD`}`,
          `remaining: ${s.remainingUsd === null ? "not available" : `${s.remainingUsd.toFixed(4)} USD`}`,
        ];
        return {
          content: [
            { type: "text" as const, text: lines.join("\n") },
            ...(includeRaw ? [{ type: "text" as const, text: `\nraw response:\n${JSON.stringify(snapshot.raw, null, 2)}` }] : []),
          ],
          structuredContent: { provider: snapshot.provider, summary: snapshot.summary },
        };
      } catch (err) {
        return { isError: true, content: [{ type: "text" as const, text: `get_usage failed: ${errorMessage(err)}` }] };
      }
    },
  );

  server.registerTool(
    "run_eval",
    {
      title: "Run model comparison",
      description:
        "Runs the same prompt set (a JSON file) on several models and reports price, latency and answer " +
        "side by side. Quality is scored with a contains check and an optional LLM judge.",
      inputSchema: {
        promptSetPath: z.string().min(1).describe("Path to a JSON file: an array of { id, prompt, systemPrompt?, expectedContains? }"),
        models: z.array(z.string().min(1)).min(1).describe("Model ids to compare, as named in the OpenAI-compatible API"),
        judge: z.boolean().optional().describe("Override config.yaml eval.judge.enabled for this run"),
      },
    },
    async (input) => {
      try {
        const report = await runEval(config, input, db);
        const summaryLines = report.perModel.map((m) => {
          const parts = [
            `${m.model}:`,
            `avg latency ${m.avgLatencyMs.toFixed(0)} ms`,
            m.passRate !== null ? `pass ${(m.passRate * 100).toFixed(0)}%` : null,
            m.avgJudgeScore !== null ? `avg judge ${m.avgJudgeScore.toFixed(2)}/5` : null,
            m.judgeErrorCount > 0 ? `judge score missing ${m.judgeErrorCount}/${m.caseCount}` : null,
            m.avgPriceUsd !== null ? `avg price ${m.avgPriceUsd.toFixed(6)} USD` : null,
            m.errorCount > 0 ? `errors ${m.errorCount}/${m.caseCount}` : null,
          ].filter(Boolean);
          return `- ${parts.join(" | ")}`;
        });

        const taskTypeLines = report.perTaskType.map((t) => {
          const parts = [
            `${t.taskType} / ${t.model}:`,
            `passed ${t.passedCount}/${t.expectedCount}`,
            `errors ${t.errorCount}/${t.caseCount}`,
            `avg latency ${t.avgLatencyMs.toFixed(0)} ms`,
            t.avgPriceUsd !== null ? `avg price ${t.avgPriceUsd.toFixed(6)} USD` : null,
            t.passRateIncludingErrors !== null ? `pass% (errors included) ${(t.passRateIncludingErrors * 100).toFixed(0)}%` : null,
            t.passRateExcludingErrors !== null ? `pass% (errors excluded) ${(t.passRateExcludingErrors * 100).toFixed(0)}%` : null,
          ].filter(Boolean);
          return `- ${parts.join(" | ")}`;
        });

        return {
          content: [
            {
              type: "text" as const,
              text: [
                `Eval run ${report.runId} (${report.cases.length} answers, judge ${report.judgeUsed ? "on" : "off"}):`,
                summaryLines.join("\n"),
                "",
                "Per task type:",
                taskTypeLines.join("\n"),
              ].join("\n"),
            },
          ],
          structuredContent: report as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return { isError: true, content: [{ type: "text" as const, text: `run_eval failed: ${errorMessage(err)}` }] };
      }
    },
  );

  return server;
}
