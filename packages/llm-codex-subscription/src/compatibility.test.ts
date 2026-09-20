import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(resolve(packageRoot, "release/manifest.json"), "utf8"));

describe("DSH 0.1.6-alpha.2 compatibility", () => {
  it("declares and independently boots the complete exact alpha.2 peer graph", () => {
    expect(packageJson.version).toBe("0.1.4");
    expect(packageJson.dependencies["@earendil-works/pi-ai"]).toBe("0.85.1");
    expect(packageJson.devDependencies).toMatchObject({
      "@deepseek-ai/dsh-attachment": "0.1.6-alpha.2",
      "@deepseek-ai/dsh-launch-environment": "0.1.6-alpha.2",
      "@deepseek-ai/dsh-llm": "0.1.6-alpha.2",
      "@deepseek-ai/dsh-llm-pi-ai": "0.1.6-alpha.2",
    });
    expect(manifest.compatibilityProfiles["dsh-0.1.6-alpha.2"]).toEqual({
      "@deepseek-ai/cordis": "4.0.2",
      "@deepseek-ai/dsh-attachment": "0.1.6-alpha.2",
      "@deepseek-ai/dsh-launch-environment": "0.1.6-alpha.2",
      "@deepseek-ai/dsh-llm": "0.1.6-alpha.2",
      "@deepseek-ai/dsh-llm-pi-ai": "0.1.6-alpha.2",
    });
    for (const peer of manifest.compatibilityPeers) {
      expect(packageJson.peerDependencies[peer].split(" || ")).toContain(
        manifest.compatibilityProfiles["dsh-0.1.6-alpha.2"][peer],
      );
    }
  });
});
