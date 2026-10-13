/**
 * Kevyt asiakas OpenAI-yhteensopivalle /chat/completions-rajapinnalle.
 * Toimii sellaisenaan LiteLLM-proxyn tai suoraan OpenRouterin kanssa -
 * ei suoria Anthropic-kutsuja, vain HTTP(S) määriteltyyn base URL:iin.
 */

import { estimateInputTokens, type TokenBudget } from "./budget.js";
import { EmptyResponseError, LimitExceededError, MAX_TOKENS_PER_CALL } from "./limits.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ChatCompletionResult {
  text: string;
  model: string;
  usage?: ChatUsage;
  raw: unknown;
}

export interface CallChatCompletionOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  messages: ChatMessage[];
  timeoutMs?: number;
  temperature?: number;
  maxTokens?: number;
  /** Pakollinen: jokainen kutsu varaa budjetista ennen lähettämistä. */
  budget: TokenBudget;
}

export function joinUrl(baseUrl: string, path: string): string {
  return baseUrl.replace(/\/+$/, "") + path;
}

export function authHeaders(apiKey?: string): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

export async function callChatCompletion(opts: CallChatCompletionOptions): Promise<ChatCompletionResult> {
  // 1) Kattotarkistus ennen mitään muuta: liian suurta max_tokensia ei pienennetä hiljaa, vaan kutsu hylätään.
  if (opts.maxTokens !== undefined) {
    if (!Number.isInteger(opts.maxTokens) || opts.maxTokens < 1 || opts.maxTokens > MAX_TOKENS_PER_CALL) {
      throw new LimitExceededError(`maxTokens täytyy olla kokonaisluku väliltä 1-${MAX_TOKENS_PER_CALL}; kutsua ei tehty`);
    }
  }
  const maxTokens = opts.maxTokens ?? MAX_TOKENS_PER_CALL;

  // 2) Varaus ENNEN kutsua: syötteen arvio + max_tokens. Epäonnistunut kutsu ei vapauta varausta.
  const reservation = opts.budget.reserve(estimateInputTokens(opts.messages) + maxTokens);

  const url = joinUrl(opts.baseUrl, "/chat/completions");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeaders(opts.apiKey),
      },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        max_tokens: maxTokens,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Mallipyyntö malliin '${opts.model}' epäonnistui (${res.status} ${res.statusText}): ${body.slice(0, 500)}`);
    }

    const json = (await res.json()) as {
      model?: string;
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };

    const content: unknown = json.choices?.[0]?.message?.content;
    const text = typeof content === "string" ? content : "";
    const usage = json.usage
      ? {
          promptTokens: json.usage.prompt_tokens,
          completionTokens: json.usage.completion_tokens,
          totalTokens: json.usage.total_tokens,
        }
      : undefined;

    // 3) Korjaa varaus toteutuneeseen käyttöön; ilman usagea varaus jää voimaan.
    reservation.settle(usage ? (usage.totalTokens ?? (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0)) : undefined);

    // Tyhjä, pelkkää whitespacea oleva tai puuttuva (myös katkaistu tyhjäksi) vastaus ei ole onnistuminen.
    if (text.trim() === "") {
      throw new EmptyResponseError(opts.model);
    }

    return { text, model: json.model ?? opts.model, usage, raw: json };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Mallipyyntö malliin '${opts.model}' aikakatkaistiin (${opts.timeoutMs ?? 60_000} ms)`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
