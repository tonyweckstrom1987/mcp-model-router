import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../config/schema.js";
import type { Db } from "../lib/db.js";
import { routeAndComplete } from "../router/routeAndComplete.js";
import { fetchUsage } from "../usage/usageProviders.js";
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
      title: "Reititä ja täydennä",
      description:
        "Valitsee mallin tehtävätyypin mukaan config.yaml:sta ja kutsuu sitä OpenAI-yhteensopivan rajapinnan " +
        "(LiteLLM-proxy tai OpenRouter) kautta. Käyttää varamallia, jos päämalli epäonnistuu.",
      inputSchema: {
        taskType: z
          .string()
          .min(1)
          .describe("Tehtävätyyppi config.yaml:n 'tasks'-avainten mukaan, esim. 'general', 'code', 'writing' tai 'orchestration'"),
        prompt: z.string().min(1).describe("Käyttäjäviesti/promptti mallille"),
        systemPrompt: z.string().optional().describe("Valinnainen järjestelmäpromptti, ohittaa config.yaml:n oletuksen"),
        temperature: z.number().min(0).max(2).optional().describe("Valinnainen temperature-parametri"),
        maxTokens: z.number().int().positive().optional().describe("Valinnainen max_tokens-yläraja vastaukselle"),
      },
    },
    async (input) => {
      try {
        const result = await routeAndComplete(config, input, db);
        const metaLines = [
          `malli: ${result.modelUsed}${result.usedFallback ? " (varamalli käytössä)" : ""}`,
          `viive: ${result.latencyMs} ms`,
        ];
        if (result.usage?.totalTokens !== undefined) {
          metaLines.push(`tokenit: ${result.usage.totalTokens}`);
        }
        if (result.primaryError) {
          metaLines.push(`päämallin virhe: ${result.primaryError}`);
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
          content: [{ type: "text" as const, text: `route_and_complete epäonnistui: ${errorMessage(err)}` }],
        };
      }
    },
  );

  server.registerTool(
    "list_models",
    {
      title: "Listaa mallit",
      description: "Listaa config.yaml:ssa määritellyt tehtävätyypit ja niihin liitetyt pää- ja varamallit.",
      inputSchema: {
        taskType: z.string().optional().describe("Valinnainen suodatin: näytä vain tämän tehtävätyypin reititys"),
      },
    },
    async ({ taskType }) => {
      const entries = Object.entries(config.tasks).filter(([key]) => !taskType || key === taskType);
      if (entries.length === 0) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Tehtävätyyppiä '${taskType}' ei löydy config.yaml:sta.` }],
        };
      }
      const lines = entries.map(
        ([task, route]) => `- ${task}: ${route.model}${route.fallbackModel ? ` (varamalli: ${route.fallbackModel})` : ""}`,
      );
      return {
        content: [{ type: "text" as const, text: `Tehtävätyypeittäin määritellyt mallit:\n${lines.join("\n")}` }],
        structuredContent: {
          tasks: Object.fromEntries(entries.map(([task, route]) => [task, route])),
        },
      };
    },
  );

  server.registerTool(
    "get_usage",
    {
      title: "Näytä kulutus ja budjetti",
      description:
        "Lukee kulutuksen ja budjetin tilan LiteLLM:n tai OpenRouterin rajapinnasta (config.yaml: usage.provider). " +
        "Ei omaa kirjanpitoa kulutukselle.",
      inputSchema: {
        includeRaw: z.boolean().optional().describe("Sisällytä rajapinnan raaka JSON-vastaus tulokseen (oletus false)"),
      },
    },
    async ({ includeRaw }) => {
      try {
        const snapshot = await fetchUsage(config.usage);
        const s = snapshot.summary;
        const lines = [
          `lähde: ${snapshot.provider}`,
          `kulutus: ${s.spendUsd === null ? "ei saatavilla" : `${s.spendUsd.toFixed(4)} USD`}`,
          `budjetti: ${s.budgetUsd === null ? "ei saatavilla" : `${s.budgetUsd.toFixed(4)} USD`}`,
          `jäljellä: ${s.remainingUsd === null ? "ei saatavilla" : `${s.remainingUsd.toFixed(4)} USD`}`,
        ];
        return {
          content: [
            { type: "text" as const, text: lines.join("\n") },
            ...(includeRaw ? [{ type: "text" as const, text: `\nraaka vastaus:\n${JSON.stringify(snapshot.raw, null, 2)}` }] : []),
          ],
          structuredContent: { provider: snapshot.provider, summary: snapshot.summary },
        };
      } catch (err) {
        return { isError: true, content: [{ type: "text" as const, text: `get_usage epäonnistui: ${errorMessage(err)}` }] };
      }
    },
  );

  server.registerTool(
    "run_eval",
    {
      title: "Aja mallivertailu",
      description:
        "Ajaa saman prompt-sarjan (JSON-tiedosto) usealla mallilla ja raportoi hinnan, viiveen ja vastauksen " +
        "rinnakkain. Laatu arvioidaan sisältää-tarkistuksella ja valinnaisella LLM-tuomarilla.",
      inputSchema: {
        promptSetPath: z.string().min(1).describe("Polku JSON-tiedostoon: taulukko { id, prompt, systemPrompt?, expectedContains? }"),
        models: z.array(z.string().min(1)).min(1).describe("Vertailtavien mallien tunnisteet OpenAI-yhteensopivassa rajapinnassa"),
        judge: z.boolean().optional().describe("Ohita config.yaml:n eval.judge.enabled-asetus tälle ajolle"),
      },
    },
    async (input) => {
      try {
        const report = await runEval(config, input, db);
        const summaryLines = report.perModel.map((m) => {
          const parts = [
            `${m.model}:`,
            `viive ka. ${m.avgLatencyMs.toFixed(0)} ms`,
            m.passRate !== null ? `läpäisy ${(m.passRate * 100).toFixed(0)}%` : null,
            m.avgJudgeScore !== null ? `tuomari ka. ${m.avgJudgeScore.toFixed(2)}/5` : null,
            m.avgPriceUsd !== null ? `hinta ka. ${m.avgPriceUsd.toFixed(6)} USD` : null,
            m.errorCount > 0 ? `virheitä ${m.errorCount}/${m.caseCount}` : null,
          ].filter(Boolean);
          return `- ${parts.join(" | ")}`;
        });

        const taskTypeLines = report.perTaskType.map((t) => {
          const parts = [
            `${t.taskType} / ${t.model}:`,
            `läpäisty ${t.passedCount}/${t.expectedCount}`,
            `virheitä ${t.errorCount}/${t.caseCount}`,
            `viive ka. ${t.avgLatencyMs.toFixed(0)} ms`,
            t.avgPriceUsd !== null ? `hinta ka. ${t.avgPriceUsd.toFixed(6)} USD` : null,
            t.passRateIncludingErrors !== null ? `läpäisy% (virheet mukana) ${(t.passRateIncludingErrors * 100).toFixed(0)}%` : null,
            t.passRateExcludingErrors !== null ? `läpäisy% (virheet pois) ${(t.passRateExcludingErrors * 100).toFixed(0)}%` : null,
          ].filter(Boolean);
          return `- ${parts.join(" | ")}`;
        });

        return {
          content: [
            {
              type: "text" as const,
              text: [
                `Eval-ajo ${report.runId} (${report.cases.length} vastausta, tuomari ${report.judgeUsed ? "käytössä" : "pois päältä"}):`,
                summaryLines.join("\n"),
                "",
                "Tehtävätyypeittäin:",
                taskTypeLines.join("\n"),
              ].join("\n"),
            },
          ],
          structuredContent: report as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return { isError: true, content: [{ type: "text" as const, text: `run_eval epäonnistui: ${errorMessage(err)}` }] };
      }
    },
  );

  return server;
}
