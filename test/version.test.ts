import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AppConfigSchema } from "../src/config/schema.js";
import { loadConfig } from "../src/config/load.js";

// The version appears in several files. An MCP client sees `server.version`
// (the schema default or the value in the user's config), npm sees package.json.
// A release that bumps only some of them reports the wrong version to clients.
const file = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const pkg = JSON.parse(readFileSync(file("package.json"), "utf8")) as { version: string };
const lock = JSON.parse(readFileSync(file("package-lock.json"), "utf8")) as {
  version: string;
  packages: Record<string, { version?: string }>;
};

describe("version consistency", () => {
  it("package-lock.json matches package.json", () => {
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[""]?.version).toBe(pkg.version);
  });

  it("the default server.version matches package.json", () => {
    const defaults = AppConfigSchema.shape.server.parse(undefined);
    expect(defaults.version).toBe(pkg.version);
    expect(AppConfigSchema.shape.server.parse({}).version).toBe(pkg.version);
  });

  it.each(["config.example.yaml", "examples/routing-demo/demo-config.yaml"])(
    "%s server.version matches package.json",
    (p) => {
      const config = loadConfig({ configPath: file(p), env: {} });
      expect(config.server.version).toBe(pkg.version);
    },
  );

  it("CHANGELOG has a section for the package version", () => {
    const changelog = readFileSync(file("CHANGELOG.md"), "utf8");
    expect(changelog).toMatch(new RegExp(`^## \\[${pkg.version.replace(/\./g, "\\.")}\\]`, "m"));
  });
});
