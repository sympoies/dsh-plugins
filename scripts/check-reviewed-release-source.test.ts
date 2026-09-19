import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const script = resolve(import.meta.dirname, "check-reviewed-release-source.ts");
const commit = "1".repeat(40);
const head = "2".repeat(40);

function fixture({ findings = {}, reviewedHead = head, association = "OWNER", permission = "admin" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "dsh-reviewed-release-test-"));
  roots.push(root);
  const associations = join(root, "associations.json");
  const comments = join(root, "comments.json");
  const reviewers = join(root, "reviewers.json");
  writeFileSync(associations, JSON.stringify([{
    number: 7,
    state: "closed",
    merged_at: "2026-09-19T00:00:00Z",
    merge_commit_sha: commit,
    base: { ref: "main", repo: { full_name: "sympoies/dsh-plugins" } },
    head: { sha: head, repo: { full_name: "sympoies/dsh-plugins" } },
  }]));
  const state = {
    repository: "sympoies/dsh-plugins",
    pr: 7,
    expected_head: reviewedHead,
    payload: { state: { head_sha: reviewedHead, findings } },
    record_digest: "sha256:reviewed",
  };
  const marker = Buffer.from(JSON.stringify(state)).toString("hex");
  writeFileSync(comments, JSON.stringify([{
    user: { login: "reviewer" },
    author_association: association,
    body: `Review checkpoint.\n<!-- forge-cli:review-state:v1 ${marker} -->`,
  }]));
  writeFileSync(reviewers, JSON.stringify({ reviewer: permission }));
  return { associations, comments, reviewers };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function verify(paths: ReturnType<typeof fixture>) {
  return execFileSync(process.execPath, [
    script,
    "--repository", "sympoies/dsh-plugins",
    "--commit", commit,
    "--associations", paths.associations,
    "--comments", paths.comments,
    "--reviewers", paths.reviewers,
  ], { encoding: "utf8" });
}

describe("reviewed release source", () => {
  it("accepts the exact merged head with a converged review checkpoint", () => {
    expect(JSON.parse(verify(fixture())).reviewed_head).toBe(head);
  });

  it("uses repository permission when workflow tokens redact organization membership", () => {
    expect(JSON.parse(verify(fixture({ association: "CONTRIBUTOR", permission: "maintain" }))).reviewed_head).toBe(head);
    expect(() => verify(fixture({ association: "CONTRIBUTOR", permission: "read" }))).toThrow();
  });

  it("rejects stale review state and open findings", () => {
    expect(() => verify(fixture({ reviewedHead: "3".repeat(40) }))).toThrow();
    expect(() => verify(fixture({ findings: { open: { disposition: "open" } } }))).toThrow();
  });
});
