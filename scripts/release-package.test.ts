import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  freshInstallSpec,
  releaseLock,
  resolveReleasePlan,
  validateInventory,
  verifyFreshBoot,
} from "./release-package.js";

const roots: string[] = [];

function fixture(
  overrides: Record<string, unknown> = {},
  releaseOverrides: Record<string, unknown> = {},
) {
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
    files: ["lib", "README.md", "LICENSE", "NOTICE", "cordis.patch.yml"],
    scripts: { build: "tsc", "test:coverage": "vitest --coverage" },
    repository: {
      url: "git+https://github.com/sympoies/dsh-plugins.git",
      directory: "packages/example",
    },
    peerDependencies: {
      "@deepseek-ai/dsh": "0.1.1-rc.2",
    },
    ...overrides,
  };
  writeFileSync(join(workspace, "package.json"), JSON.stringify(packageJson));
  writeFileSync(join(workspace, "README.md"), "example\n");
  writeFileSync(join(workspace, "LICENSE"), "MIT\n");
  writeFileSync(join(workspace, "NOTICE"), "Attribution\n");
  writeFileSync(join(workspace, "cordis.patch.yml"), "plugins: []\n");
  mkdirSync(join(workspace, "release"));
  writeFileSync(join(workspace, "release/manifest.json"), JSON.stringify({
    schemaVersion: "dsh-plugin-release.v2",
    tagPrefix: "dsh-example",
    compatibilityPeers: ["@deepseek-ai/dsh"],
    smokeModule: "release/smoke.mjs",
    ...releaseOverrides,
  }));
  writeFileSync(join(workspace, "release/smoke.mjs"), "export {};\n");
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

  it("rejects a package without exact declared compatibility", () => {
    const root = fixture({ peerDependencies: { "@deepseek-ai/dsh": "^0.1.1-rc.2" } });
    expect(() => resolveReleasePlan(root, "dsh-example-v1.2.3")).toThrow("pin exact @deepseek-ai/dsh");
  });

  it("rejects release metadata from the published package inventory", () => {
    const root = fixture({ files: ["lib", "README.md", "LICENSE", "release/manifest.json"] });
    expect(() => resolveReleasePlan(root, "dsh-example-v1.2.3")).toThrow("release files must be excluded");
  });

  it("declares package-specific fresh-install behavior", () => {
    const root = fixture({}, {
      legacyPeerDeps: true,
      smokeDependencies: {
        "@deepseek-ai/cordis-plugin-group": "1.0.1",
        "@deepseek-ai/dsh-invariants": "0.1.1-rc.2",
      },
    });
    const plan = resolveReleasePlan(root, "dsh-example-v1.2.3");

    expect(plan.legacy_peer_deps).toBe(true);
    expect(plan.smoke_dependencies).toEqual({
      "@deepseek-ai/cordis-plugin-group": "1.0.1",
      "@deepseek-ai/dsh-invariants": "0.1.1-rc.2",
    });
    expect(freshInstallSpec(plan, "/tmp/plugin.tgz")).toEqual({
      dependencies: {
        "@deepseek-ai/dsh": "0.1.1-rc.2",
        "@deepseek-ai/cordis-plugin-group": "1.0.1",
        "@deepseek-ai/dsh-invariants": "0.1.1-rc.2",
        "@sympoies/dsh-example": "file:/tmp/plugin.tgz",
      },
      install_arguments: [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        "--legacy-peer-deps",
      ],
    });

    const calls: Array<{ command: string; arguments_: string[] }> = [];
    let installedDependencies: Record<string, string> | undefined;
    verifyFreshBoot(root, plan, "/tmp/plugin.tgz", (command, arguments_, options) => {
      calls.push({ command, arguments_ });
      if (command === "npm") {
        installedDependencies = JSON.parse(readFileSync(join(options.cwd, "package.json"), "utf8")).dependencies;
      }
    });
    expect(calls).toEqual([
      { command: "npm", arguments_: freshInstallSpec(plan, "/tmp/plugin.tgz").install_arguments },
      { command: "node", arguments_: ["boot.mjs"] },
    ]);
    expect(installedDependencies).toEqual(freshInstallSpec(plan, "/tmp/plugin.tgz").dependencies);

    expect(releaseLock(plan, "a".repeat(40), "plugin.tgz", "b".repeat(64))).toMatchObject({
      peer_dependencies: { "@deepseek-ai/dsh": "0.1.1-rc.2" },
      smoke_dependencies: {
        "@deepseek-ai/cordis-plugin-group": "1.0.1",
        "@deepseek-ai/dsh-invariants": "0.1.1-rc.2",
      },
      legacy_peer_deps: true,
    });
  });

  it("keeps fresh-install options disabled by default", () => {
    const plan = resolveReleasePlan(fixture(), "dsh-example-v1.2.3");
    expect(plan.legacy_peer_deps).toBe(false);
    expect(plan.smoke_dependencies).toEqual({});
    expect(freshInstallSpec(plan, "/tmp/plugin.tgz").install_arguments).not.toContain("--legacy-peer-deps");
  });

  it("rejects invalid fresh-install declarations", () => {
    expect(() => resolveReleasePlan(
      fixture({}, { legacyPeerDeps: "yes" }),
      "dsh-example-v1.2.3",
    )).toThrow("legacyPeerDeps must be a boolean");
    expect(() => resolveReleasePlan(
      fixture({}, { smokeDependencies: { "@deepseek-ai/dsh-invariants": "^0.1.1-rc.2" } }),
      "dsh-example-v1.2.3",
    )).toThrow("must pin an exact version");
    expect(() => resolveReleasePlan(
      fixture({}, { smokeDependencies: { "@deepseek-ai/dsh": "0.1.1-rc.2" } }),
      "dsh-example-v1.2.3",
    )).toThrow("must not duplicate peerDependencies");
  });
});

describe("package inventory", () => {
  it("accepts runtime files and rejects test leakage", () => {
    const plan = resolveReleasePlan(fixture(), "dsh-example-v1.2.3");
    const files = [
      "package/package.json",
      "package/README.md",
      "package/LICENSE",
      "package/NOTICE",
      "package/cordis.patch.yml",
      "package/lib/index.js",
      "package/lib/index.d.ts",
    ];
    expect(() => validateInventory(plan, files)).not.toThrow();
    expect(() => validateInventory(plan, [...files, "package/src/index.test.ts"])).toThrow("unexpected files");
  });
});
