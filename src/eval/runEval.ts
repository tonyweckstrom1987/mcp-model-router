import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppConfig } from "../config/schema.js";
import { callChatCompletion, type ChatMessage } from "../lib/openaiClient.js";
import type { Db } from "../lib/db.js";

const EvalPromptCaseSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  systemPrompt: z.string().optional(),
  expectedContains: z.string().optional(),
});
export type EvalPromptCase = z.infer<typeof EvalPromptCaseSchema>;

const EvalPromptSetSchema = z.array(EvalPromptCaseSchema).min(1, "prompt-tiedostossa täytyy olla vähintään yksi tehtävä");

export function loadPromptSet(path: string): EvalPromptCase[] {
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Prompt-tiedosto '${path}' ei ole kelvollista JSON:ia: ${err instanceof Error ? err.message : String(err)}`);
  }
  const result = EvalPromptSetSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join(".") || "(juuri)"}: ${i.message}`).join("\n");
    throw new Error(`Prompt-tiedosto '${path}' ei kelpaa:\n${issues}`);
  }
  return result.data;
}

export interface EvalCaseResult {
  promptId: string;
  model: string;
  latencyMs: number;
  response: string;
  passed: boolean | null;
  judgeScore: number | null;
  priceUsd: number | null;
  error: string | null;
}

export interface EvalModelSummary {
  model: string;
  avgLatencyMs: number;
  passRate: number | null;
  avgJudgeScore: number | null;
  avgPriceUsd: number | null;
  errorCount: number;
  caseCount: number;
}

export interface EvalReport {
  runId: string;
  promptSetPath: string;
  models: string[];
  judgeUsed: boolean;
  cases: EvalCaseResult[];
  perModel: EvalModelSummary[];
}

export interface RunEvalInput {
  promptSetPath: string;
  models: string[];
  judge?: boolean;
  runId?: string;
}

async function judgeResponse(config: AppConfig, testCase: EvalPromptCase, responseText: string): Promise<number | null> {
  const judgeModel = config.eval.judge.model;
  if (!judgeModel) return null;
  const system =
    config.eval.judge.systemPrompt ??
    "Olet tiukka arvioija. Arvioi vastauksen laatu asteikolla 1-5 ja vastaa PELKÄLLÄ numerolla.";
  const userPrompt = [
    `Tehtävänanto:\n${testCase.prompt}`,
    testCase.expectedContains ? `Odotettu sisältö: ${testCase.expectedContains}` : null,
    `Mallin vastaus:\n${responseText}`,
    "Anna laatuarvio asteikolla 1-5 (pelkkä numero, ei muuta tekstiä).",
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    const result = await callChatCompletion({
      baseUrl: config.provider.baseUrl,
      apiKey: config.provider.apiKey,
      model: judgeModel,
      timeoutMs: config.provider.timeoutMs,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userPrompt },
      ],
    });
    const match = result.text.match(/[1-5](\.\d+)?/);
    return match ? parseFloat(match[0]) : null;
  } catch {
    return null;
  }
}

function estimatePriceUsd(
  config: AppConfig,
  model: string,
  usage: { promptTokens?: number; completionTokens?: number } | undefined,
): number | null {
  const pricing = config.eval.pricing[model];
  if (!pricing || !usage) return null;
  const promptTokens = usage.promptTokens ?? 0;
  const completionTokens = usage.completionTokens ?? 0;
  return (promptTokens / 1_000_000) * pricing.inputPerMillionUsd + (completionTokens / 1_000_000) * pricing.outputPerMillionUsd;
}

function summarizePerModel(models: string[], results: EvalCaseResult[]): EvalModelSummary[] {
  return models.map((model) => {
    const modelResults = results.filter((r) => r.model === model);
    const latencies = modelResults.map((r) => r.latencyMs);
    const avgLatencyMs = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;

    const withExpectation = modelResults.filter((r) => r.passed !== null);
    const passRate = withExpectation.length
      ? withExpectation.filter((r) => r.passed === true).length / withExpectation.length
      : null;

    const withJudge = modelResults.filter((r) => r.judgeScore !== null) as Array<EvalCaseResult & { judgeScore: number }>;
    const avgJudgeScore = withJudge.length ? withJudge.reduce((a, b) => a + b.judgeScore, 0) / withJudge.length : null;

    const withPrice = modelResults.filter((r) => r.priceUsd !== null) as Array<EvalCaseResult & { priceUsd: number }>;
    const avgPriceUsd = withPrice.length ? withPrice.reduce((a, b) => a + b.priceUsd, 0) / withPrice.length : null;

    return {
      model,
      avgLatencyMs,
      passRate,
      avgJudgeScore,
      avgPriceUsd,
      errorCount: modelResults.filter((r) => r.error !== null).length,
      caseCount: modelResults.length,
    };
  });
}

/**
 * Ajaa saman prompt-sarjan usealla mallilla ja raportoi hinnan, viiveen ja
 * vastauksen rinnakkain. Laatu arvioidaan yksinkertaisella
 * sisältää-tarkistuksella ja valinnaisella LLM-tuomarilla.
 */
export async function runEval(config: AppConfig, input: RunEvalInput, db?: Db): Promise<EvalReport> {
  const cases = loadPromptSet(input.promptSetPath);
  const runId = input.runId ?? randomUUID();
  const judgeUsed = input.judge ?? config.eval.judge.enabled;
  const results: EvalCaseResult[] = [];

  for (const model of input.models) {
    for (const testCase of cases) {
      const messages: ChatMessage[] = [];
      if (testCase.systemPrompt) messages.push({ role: "system", content: testCase.systemPrompt });
      messages.push({ role: "user", content: testCase.prompt });

      const start = Date.now();
      try {
        const result = await callChatCompletion({
          baseUrl: config.provider.baseUrl,
          apiKey: config.provider.apiKey,
          model,
          messages,
          timeoutMs: config.provider.timeoutMs,
        });
        const latencyMs = Date.now() - start;
        const passed = testCase.expectedContains
          ? result.text.toLowerCase().includes(testCase.expectedContains.toLowerCase())
          : null;
        const judgeScore = judgeUsed ? await judgeResponse(config, testCase, result.text) : null;
        const priceUsd = estimatePriceUsd(config, model, result.usage);

        const row: EvalCaseResult = {
          promptId: testCase.id,
          model,
          latencyMs,
          response: result.text,
          passed,
          judgeScore,
          priceUsd,
          error: null,
        };
        results.push(row);
        db?.insertEvalResult({ runId, promptId: row.promptId, model, latencyMs, response: row.response, passed, judgeScore, priceUsd, errorMessage: null });
      } catch (err) {
        const latencyMs = Date.now() - start;
        const message = err instanceof Error ? err.message : String(err);
        const row: EvalCaseResult = {
          promptId: testCase.id,
          model,
          latencyMs,
          response: "",
          passed: null,
          judgeScore: null,
          priceUsd: null,
          error: message,
        };
        results.push(row);
        db?.insertEvalResult({ runId, promptId: row.promptId, model, latencyMs, response: "", passed: null, judgeScore: null, priceUsd: null, errorMessage: message });
      }
    }
  }

  db?.insertEvalRun({ runId, promptSetPath: input.promptSetPath, models: input.models, judgeUsed });

  return {
    runId,
    promptSetPath: input.promptSetPath,
    models: input.models,
    judgeUsed,
    cases: results,
    perModel: summarizePerModel(input.models, results),
  };
}
