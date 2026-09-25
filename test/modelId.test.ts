import { describe, it, expect } from "vitest";
import { resolveModelId } from "../src/lib/modelId.js";

describe("resolveModelId", () => {
  it("jättää tunnisteen ennalleen kun provider.kind on litellm", () => {
    expect(resolveModelId({ kind: "litellm" }, "openrouter/deepseek/deepseek-v4.1-flash")).toBe(
      "openrouter/deepseek/deepseek-v4.1-flash",
    );
  });

  it("karsii openrouter/-etuliitteen kun provider.kind on openrouter", () => {
    expect(resolveModelId({ kind: "openrouter" }, "openrouter/deepseek/deepseek-v4.1-flash")).toBe(
      "deepseek/deepseek-v4.1-flash",
    );
  });

  it("ei muuta tunnistetta jos etuliitettä ei ole, vaikka kind on openrouter", () => {
    expect(resolveModelId({ kind: "openrouter" }, "deepseek/deepseek-v4.1-flash")).toBe("deepseek/deepseek-v4.1-flash");
  });
});
