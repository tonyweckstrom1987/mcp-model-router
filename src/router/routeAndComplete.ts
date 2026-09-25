import type { AppConfig } from "../config/schema.js";
import { callChatCompletion, type ChatMessage } from "../lib/openaiClient.js";
import { resolveModelId } from "../lib/modelId.js";
import type { Db } from "../lib/db.js";

export interface RouteAndCompleteInput {
  taskType: string;
  prompt: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface RouteAndCompleteResult {
  taskType: string;
  modelRequested: string;
  modelUsed: string;
  usedFallback: boolean;
  text: string;
  latencyMs: number;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  primaryError?: string;
}

/**
 * Valitsee mallin tehtävätyypin mukaan config.yaml:sta ja kutsuu sitä
 * OpenAI-yhteensopivan rajapinnan kautta. Jos päämalli epäonnistuu ja
 * varamalli on määritelty, yritetään sitä ennen virheen heittämistä.
 */
export async function routeAndComplete(
  config: AppConfig,
  input: RouteAndCompleteInput,
  db?: Db,
): Promise<RouteAndCompleteResult> {
  const route = config.tasks[input.taskType];
  if (!route) {
    throw new Error(
      `Tuntematon tehtävätyyppi '${input.taskType}'. Saatavilla config.yaml:ssa: ${Object.keys(config.tasks).join(", ")}`,
    );
  }

  const messages: ChatMessage[] = [];
  const systemPrompt = input.systemPrompt ?? route.systemPrompt;
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: input.prompt });

  const start = Date.now();
  let usedFallback = false;
  let primaryError: string | undefined;

  const callOpts = {
    baseUrl: config.provider.baseUrl,
    apiKey: config.provider.apiKey,
    messages,
    timeoutMs: config.provider.timeoutMs,
    temperature: input.temperature,
    maxTokens: input.maxTokens,
  };

  try {
    const result = await callChatCompletion({ ...callOpts, model: resolveModelId(config.provider, route.model) });
    const latencyMs = Date.now() - start;
    db?.insertCallLog({
      taskType: input.taskType,
      modelRequested: route.model,
      modelUsed: route.model,
      usedFallback: false,
      latencyMs,
      status: "ok",
      promptTokens: result.usage?.promptTokens ?? null,
      completionTokens: result.usage?.completionTokens ?? null,
    });
    return {
      taskType: input.taskType,
      modelRequested: route.model,
      modelUsed: result.model,
      usedFallback: false,
      text: result.text,
      latencyMs,
      usage: result.usage,
    };
  } catch (err) {
    primaryError = err instanceof Error ? err.message : String(err);
    if (!route.fallbackModel) {
      const latencyMs = Date.now() - start;
      db?.insertCallLog({
        taskType: input.taskType,
        modelRequested: route.model,
        modelUsed: route.model,
        usedFallback: false,
        latencyMs,
        status: "error",
        errorMessage: primaryError,
      });
      throw err;
    }
    usedFallback = true;
  }

  const result = await callChatCompletion({ ...callOpts, model: resolveModelId(config.provider, route.fallbackModel!) });
  const latencyMs = Date.now() - start;
  db?.insertCallLog({
    taskType: input.taskType,
    modelRequested: route.model,
    modelUsed: route.fallbackModel!,
    usedFallback: true,
    latencyMs,
    status: "ok",
    errorMessage: primaryError,
    promptTokens: result.usage?.promptTokens ?? null,
    completionTokens: result.usage?.completionTokens ?? null,
  });

  return {
    taskType: input.taskType,
    modelRequested: route.model,
    modelUsed: result.model,
    usedFallback,
    text: result.text,
    latencyMs,
    usage: result.usage,
    primaryError,
  };
}
