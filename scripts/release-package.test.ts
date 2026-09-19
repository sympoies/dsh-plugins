import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveReleasePlan, validateInventory } from "./release-package.js";

const roots: string[] = [];

function fixture(overrides: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "dsh-plugin-release-test-"));
  roots.push(root);
  const workspace = join(root, "packages/example");
  mkdirSync(workspace, { recursive: true });
  const packageJson = {
    name: "@sympoies/dsh-example",
    version: "1.2.3",
    license: "MIT",
    main: "lib/index.js",
    types: "lib/index.d.ts",
    files: ["lib", "README.md", "LICENSE"],
    scripts: { build: "tsc", "test:coverage": "vitest --coverage" },
    repository: {
      url: "git+https://github.com/sympoies/dsh-plugins.git",
      directory: "packages/example",
    },
    peerDependencies: {
      "@deepseek-ai/cordis": "4.0.2",
      "@deepseek-ai/dsh-llm": "0.1.2-rc.1",
    },
    dshRelease: {
      tagPrefix: "dsh-example",
      providerRoute: "example",
      bootConfigFile: "release/boot-config.json",
    },
    ...overrides,
  };
  writeFileSync(join(workspace, "package.json"), JSON.stringify(packageJson));
  writeFileSync(join(workspace, "README.md"), "example\n");
  writeFileSync(join(workspace, "LICENSE"), "MIT\n");
  mkdirSync(join(workspace, "release"));
  writeFileSync(join(workspace, "release/boot-config.json"), "{}\n");
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("release plan", () => {
  it("selects one independently versioned workspace", () => {
    const plan = resolveReleasePlan(fixture(), "dsh-example-v1.2.3");
    expect(plan.package_name).toBe("@sympoies/dsh-example");
    expect(plan.workspace).toBe("packages/example");
  });

  it.each([
    ["dsh-example-v1.2", "tag must be"],
    ["dsh-other-v1.2.3", "found 0"],
    ["dsh-example-v1.2.4", "does not match"],
  ])("rejects invalid selection %s", (tag, message) => {
    expect(() => resolveReleasePlan(fixture(), tag)).toThrow(message);
  });

  it("rejects a package without exact DSH compatibility", () => {
    const root = fixture({ peerDependencies: { "@deepseek-ai/cordis": "^4.0.2", "@deepseek-ai/dsh-llm": "0.1.2-rc.1" } });
    expect(() => resolveReleasePlan(root, "dsh-example-v1.2.3")).toThrow("pin exact @deepseek-ai/cordis");
  });
});

describe("package inventory", () => {
  it("accepts runtime files and rejects test leakage", () => {
    const plan = resolveReleasePlan(fixture(), "dsh-example-v1.2.3");
    const files = [
      "package/package.json",
      "package/README.md",
      "package/LICENSE",
      "package/lib/index.js",
      "package/lib/index.d.ts",
    ];
    expect(() => validateInventory(plan, files)).not.toThrow();
    expect(() => validateInventory(plan, [...files, "package/src/index.test.ts"])).toThrow("unexpected files");
  });
});
