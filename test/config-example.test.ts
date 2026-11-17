import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config/load.js";

// config.example.yaml ships in the npm package (package.json "files") and the
// README's npm quick start tells users to copy it as is. Its system prompts are
// sent to the model, so they must be in the same language as the README.
const EXAMPLE = fileURLToPath(new URL("../config.example.yaml", import.meta.url));

describe("config.example.yaml", () => {
  it("latautuu skeeman mukaisesti ilman ympäristömuuttujia", () => {
    const config = loadConfig({ configPath: EXAMPLE, env: {} });
    expect(Object.keys(config.tasks)).toEqual(["general", "code", "writing", "orchestration"]);
    expect(config.provider.baseUrl).toBe("http://localhost:4000");
  });

  it("järjestelmäkehotteet ovat englanniksi (sama kieli kuin README)", () => {
    const config = loadConfig({ configPath: EXAMPLE, env: {} });
    const prompts = [
      ...Object.values(config.tasks).map((t) => t.systemPrompt ?? ""),
      config.eval?.judge?.systemPrompt ?? "",
    ];
    expect(prompts.filter((p) => p.length > 0)).toHaveLength(5);
    for (const p of prompts) {
      expect(p).not.toMatch(/[äöåÄÖÅ]|\bOlet\b/);
    }
  });

  it("kommentit ja arvot eivät sisällä suomen kirjaimia", () => {
    const text = readFileSync(EXAMPLE, "utf8");
    const rivit = text.split("\n").filter((r) => /[äöåÄÖÅ]/.test(r));
    expect(rivit).toEqual([]);
  });
});
