import { z } from "zod";

/**
 * Yhden tehtävätyypin reititys: ensisijainen malli ja valinnainen varamalli.
 */
export const ModelRouteSchema = z.object({
  model: z.string().min(1, "malli on pakollinen"),
  fallbackModel: z.string().min(1).optional(),
  systemPrompt: z.string().optional(),
});
export type ModelRoute = z.infer<typeof ModelRouteSchema>;

export const ProviderConfigSchema = z.object({
  // OpenAI-yhteensopiva base URL, esim. LiteLLM-proxy tai OpenRouterin /api/v1
  baseUrl: z.string().url("provider.baseUrl täytyy olla kelvollinen URL"),
  apiKey: z.string().optional().default(""),
  timeoutMs: z.number().int().positive().default(60_000),
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const UsageConfigSchema = z.object({
  // Kumman rajapintamuotoa /get_usage lukee
  provider: z.enum(["litellm", "openrouter"]).default("litellm"),
  baseUrl: z.string().url("usage.baseUrl täytyy olla kelvollinen URL"),
  apiKey: z.string().optional().default(""),
});
export type UsageConfig = z.infer<typeof UsageConfigSchema>;

export const EvalJudgeConfigSchema = z.object({
  enabled: z.boolean().default(false),
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
});

export const ModelPricingSchema = z.object({
  inputPerMillionUsd: z.number().nonnegative(),
  outputPerMillionUsd: z.number().nonnegative(),
});
export type ModelPricing = z.infer<typeof ModelPricingSchema>;

export const EvalConfigSchema = z.object({
  judge: EvalJudgeConfigSchema.default({ enabled: false }),
  // Valinnainen hinnasto $/miljoona tokenia eval-raportin hinta-arviota varten
  pricing: z.record(z.string(), ModelPricingSchema).default({}),
});
export type EvalConfig = z.infer<typeof EvalConfigSchema>;

export const DatabaseConfigSchema = z.object({
  path: z.string().min(1).default("./data/mcp-model-router.sqlite"),
});

export const AppConfigSchema = z.object({
  server: z
    .object({
      name: z.string().default("mcp-model-router"),
      version: z.string().default("0.1.0"),
    })
    .default({ name: "mcp-model-router", version: "0.1.0" }),
  provider: ProviderConfigSchema,
  tasks: z
    .record(z.string(), ModelRouteSchema)
    .refine((tasks) => Object.keys(tasks).length > 0, {
      message: "config.yaml: kohdassa 'tasks' täytyy olla vähintään yksi tehtävätyyppi",
    }),
  usage: UsageConfigSchema,
  eval: EvalConfigSchema.default({ judge: { enabled: false }, pricing: {} }),
  database: DatabaseConfigSchema.default({ path: "./data/mcp-model-router.sqlite" }),
});
export type AppConfig = z.infer<typeof AppConfigSchema>;
