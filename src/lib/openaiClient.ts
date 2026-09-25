/**
 * Kevyt asiakas OpenAI-yhteensopivalle /chat/completions-rajapinnalle.
 * Toimii sellaisenaan LiteLLM-proxyn tai suoraan OpenRouterin kanssa -
 * ei suoria Anthropic-kutsuja, vain HTTP(S) määriteltyyn base URL:iin.
 */

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
}

export function joinUrl(baseUrl: string, path: string): string {
  return baseUrl.replace(/\/+$/, "") + path;
}

export function authHeaders(apiKey?: string): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

export async function callChatCompletion(opts: CallChatCompletionOptions): Promise<ChatCompletionResult> {
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
        ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
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

    const text = json.choices?.[0]?.message?.content ?? "";
    const usage = json.usage
      ? {
          promptTokens: json.usage.prompt_tokens,
          completionTokens: json.usage.completion_tokens,
          totalTokens: json.usage.total_tokens,
        }
      : undefined;

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
