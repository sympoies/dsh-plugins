import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(resolve(packageRoot, "release/manifest.json"), "utf8"));

/** Node's package lookup: the nearest `node_modules/<name>` at or above `from`. */
function installedPackage(name: string, from: string): string {
  for (let directory = from; ; directory = dirname(directory)) {
    const candidate = resolve(directory, "node_modules", name);
    if (existsSync(resolve(candidate, "package.json"))) return realpathSync(candidate);
    if (directory === dirname(directory)) throw new Error(`${name} is not installed above ${from}`);
  }
}

const DSH_PEERS = [
  "@deepseek-ai/dsh-attachment",
  "@deepseek-ai/dsh-launch-environment",
  "@deepseek-ai/dsh-llm",
  "@deepseek-ai/dsh-llm-pi-ai",
];

describe("DSH 0.2.0-rc.2 compatibility", () => {
  it("declares exactly the 0.2.0-rc.2 peer graph and one matching release profile", () => {
    expect(packageJson.version).toBe("0.2.0");
    expect(packageJson.peerDependencies).toEqual({
      "@deepseek-ai/cordis": "4.0.4",
      ...Object.fromEntries(DSH_PEERS.map((peer) => [peer, "0.2.0-rc.2"])),
    });
    expect(manifest.compatibilityProfiles).toEqual({
      "dsh-0.2.0-rc.2": packageJson.peerDependencies,
    });
    expect([...manifest.compatibilityPeers].sort()).toEqual(
      Object.keys(packageJson.peerDependencies).sort(),
    );
  });

  it("builds on the pi-ai and schemastery versions that DSH 0.2.0-rc.2 resolves", () => {
    // The adapter hands a pi-ai provider to DSH's PiAiAdapter, so both must load one pi-ai.
    expect(packageJson.dependencies).toEqual({
      "@deepseek-ai/schemastery": "3.18.4",
      "@earendil-works/pi-ai": "0.87.1",
    });
    expect(packageJson.devDependencies).toEqual({
      "@deepseek-ai/cordis": "4.0.4",
      ...Object.fromEntries(DSH_PEERS.map((peer) => [peer, "0.2.0-rc.2"])),
    });
  });

  it("loads the same pi-ai copy as the installed DSH pi-ai adapter", () => {
    const own = installedPackage("@earendil-works/pi-ai", packageRoot);
    const dsh = installedPackage(
      "@earendil-works/pi-ai",
      installedPackage("@deepseek-ai/dsh-llm-pi-ai", packageRoot),
    );
    expect(own).toBe(dsh);
    expect(JSON.parse(readFileSync(resolve(own, "package.json"), "utf8")).version)
      .toBe(packageJson.dependencies["@earendil-works/pi-ai"]);
  });
});
