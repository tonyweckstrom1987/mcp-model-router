import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveEvalPromptPath, EVAL_PATH_REJECTED } from "../src/lib/evalPath.js";
import { runEval } from "../src/eval/runEval.js";
import type { AppConfig } from "../src/config/schema.js";

describe("resolveEvalPromptPath", () => {
  let root: string;
  let evalDir: string;
  let outside: string;
  let symlinkWorks = true;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "mcp-evalpath-"));
    evalDir = join(root, "eval");
    outside = join(root, "outside");
    mkdirSync(evalDir);
    mkdirSync(outside);
    writeFileSync(join(evalDir, "ok.json"), "[]");
    writeFileSync(join(evalDir, "UPPER.JSON"), "[]");
    writeFileSync(join(evalDir, "note.txt"), "x");
    writeFileSync(join(outside, "secret.json"), "[]");
    try {
      symlinkSync(join(outside, "secret.json"), join(evalDir, "link.json"), "file");
      symlinkSync(outside, join(evalDir, "linkdir"), "junction");
    } catch {
      symlinkWorks = false;
    }
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("hyväksyy suhteellisen polun EVAL_DIR:n sisällä", () => {
    expect(resolveEvalPromptPath("ok.json", evalDir)).toContain("ok.json");
  });

  it("hyväksyy absoluuttisen polun EVAL_DIR:n sisällä", () => {
    expect(resolveEvalPromptPath(join(evalDir, "ok.json"), evalDir)).toContain("ok.json");
  });

  it("hyväksyy päätteen kirjainkoosta riippumatta", () => {
    expect(resolveEvalPromptPath("UPPER.JSON", evalDir)).toContain("UPPER.JSON");
  });

  it("hylkää ../-polun hakemiston ulkopuolelle", () => {
    expect(() => resolveEvalPromptPath("../outside/secret.json", evalDir)).toThrow(EVAL_PATH_REJECTED);
  });

  it("hylkää absoluuttisen polun hakemiston ulkopuolelle", () => {
    expect(() => resolveEvalPromptPath(join(outside, "secret.json"), evalDir)).toThrow(EVAL_PATH_REJECTED);
  });

  it("hylkää symlinkin, joka johtaa ulos", () => {
    if (!symlinkWorks) return;
    expect(() => resolveEvalPromptPath("link.json", evalDir)).toThrow(EVAL_PATH_REJECTED);
    expect(() => resolveEvalPromptPath("linkdir/secret.json", evalDir)).toThrow(EVAL_PATH_REJECTED);
  });

  it("hylkää tyhjän ja pelkän välilyöntipolun", () => {
    expect(() => resolveEvalPromptPath("", evalDir)).toThrow(EVAL_PATH_REJECTED);
    expect(() => resolveEvalPromptPath("   ", evalDir)).toThrow(EVAL_PATH_REJECTED);
  });

  it("hylkää hakemiston itsensä ja null-tavun", () => {
    expect(() => resolveEvalPromptPath(".", evalDir)).toThrow(EVAL_PATH_REJECTED);
    expect(() => resolveEvalPromptPath("ok.json\0.txt", evalDir)).toThrow(EVAL_PATH_REJECTED);
  });

  it("hylkää muun kuin .json-päätteen", () => {
    expect(() => resolveEvalPromptPath("note.txt", evalDir)).toThrow(EVAL_PATH_REJECTED);
  });

  it("hylkää olemattoman tiedoston", () => {
    expect(() => resolveEvalPromptPath("puuttuu.json", evalDir)).toThrow(EVAL_PATH_REJECTED);
  });

  it("kieltäytyy kaikista poluista, jos EVAL_DIR:iä ei ole asetettu", () => {
    expect(() => resolveEvalPromptPath("ok.json", undefined)).toThrow(EVAL_PATH_REJECTED);
    expect(() => resolveEvalPromptPath(join(evalDir, "ok.json"), "")).toThrow(EVAL_PATH_REJECTED);
  });

  it("virheilmoitus ei paljasta polkua", () => {
    try {
      resolveEvalPromptPath("../outside/secret.json", evalDir);
      expect.unreachable();
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toContain("secret");
      expect(msg).not.toContain(evalDir);
    }
  });

  it("runEval kieltäytyy ilman EVAL_DIR:iä eikä kutsu mallia", async () => {
    const config = {
      server: { name: "t", version: "0" },
      provider: { baseUrl: "http://litellm.local:4000", apiKey: "", timeoutMs: 1000, kind: "litellm" },
      tasks: { general: { model: "m1" } },
      usage: { provider: "litellm", baseUrl: "http://litellm.local:4000", apiKey: "" },
      eval: { judge: { enabled: false }, pricing: {}, concurrency: 1, allowedModels: ["m"] },
      database: { path: ":memory:" },
    } as AppConfig;
    await expect(
      runEval(config, { promptSetPath: join(evalDir, "ok.json"), models: ["m"] }, undefined, {}),
    ).rejects.toThrow(EVAL_PATH_REJECTED);
  });
});
