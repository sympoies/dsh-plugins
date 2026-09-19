import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(resolve(import.meta.dirname, "../.github/workflows/release.yml"), "utf8");

describe("npm release workflow", () => {
  it("publishes one fixed tarball through OIDC without a token secret", () => {
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain('npm publish "$archive" --access public --provenance');
    expect(workflow).not.toContain("NODE_AUTH_TOKEN");
    expect(workflow).not.toContain("NPM_TOKEN");
  });

  it("packs once before checksum release publication", () => {
    expect(workflow.match(/release-package\.ts pack/gu)).toHaveLength(1);
    expect(workflow).toContain("sha256sum -c SHA256SUMS");
    expect(workflow).toContain("gh release create");
  });

  it("treats an npm missing-version error response as unpublished", () => {
    expect(workflow).toContain("jq -r 'strings'");
    expect(workflow).not.toContain("jq -r '. // empty'");
  });

  it("waits for a newly published version to become readable", () => {
    expect(workflow).toContain("for attempt in {1..12}; do");
    expect(workflow).toContain("npm registry did not expose the published version in time");
  });
});
