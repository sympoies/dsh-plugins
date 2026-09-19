import { readFileSync } from "node:fs";

function fail(message: string): never {
  process.stderr.write(`reviewed release source invalid: ${message}\n`);
  process.exit(1);
}

function readJson(path: string, label: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function argumentsByName(argv: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined || values.has(flag)) {
      fail("arguments must be unique --name value pairs");
    }
    values.set(flag, value);
  }
  for (const required of ["--repository", "--commit", "--associations"]) {
    if (!values.has(required)) fail(`${required} is required`);
  }
  return values;
}

const values = argumentsByName(process.argv.slice(2));
const repository = values.get("--repository")!;
const commit = values.get("--commit")!;
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) fail("repository must be owner/name");
if (!/^[0-9a-f]{40}$/.test(commit)) fail("commit must be a full lowercase Git revision");

const associations = readJson(values.get("--associations")!, "associations");
if (!Array.isArray(associations)) fail("associations must be an array");
const matches = associations.filter((pullRequest: any) =>
  Number.isInteger(pullRequest?.number) &&
  pullRequest.state === "closed" &&
  typeof pullRequest.merged_at === "string" &&
  pullRequest.merge_commit_sha === commit &&
  pullRequest.base?.ref === "main" &&
  pullRequest.base?.repo?.full_name === repository &&
  pullRequest.head?.repo?.full_name === repository &&
  /^[0-9a-f]{40}$/.test(pullRequest.head?.sha ?? ""),
);
if (matches.length !== 1) fail(`expected one merged same-repository pull request into main; found ${matches.length}`);

const pullRequest = matches[0];
const commentsPath = values.get("--comments");
if (commentsPath === undefined) {
  process.stdout.write(`${pullRequest.number}\n`);
  process.exit(0);
}

const comments = readJson(commentsPath, "comments");
if (!Array.isArray(comments)) fail("comments must be an array");
const reviewersPath = values.get("--reviewers");
const reviewers = reviewersPath === undefined ? {} : readJson(reviewersPath, "reviewers");
if (reviewers === null || typeof reviewers !== "object" || Array.isArray(reviewers)) {
  fail("reviewers must be an object");
}
const states = comments.flatMap((comment: any) => {
  const login = comment?.user?.login;
  const permission = typeof login === "string" ? reviewers[login] : undefined;
  if (
    typeof comment?.body !== "string" ||
    (!["OWNER", "MEMBER", "COLLABORATOR"].includes(comment?.author_association)
      && !["admin", "maintain", "write"].includes(permission))
  ) return [];
  const matches = [...comment.body.matchAll(/<!-- forge-cli:review-state:v1 ([0-9a-f]+) -->/gu)];
  return matches.flatMap((match) => {
    try {
      return [JSON.parse(Buffer.from(match[1], "hex").toString("utf8"))];
    } catch {
      return [];
    }
  });
});
const reviewed = states.find((state: any) =>
  state?.repository === repository &&
  state?.pr === pullRequest.number &&
  state?.expected_head === pullRequest.head.sha &&
  state?.payload?.state?.head_sha === pullRequest.head.sha &&
  !Object.values(state?.payload?.state?.findings ?? {}).some(
    (finding: any) => finding?.disposition === "open",
  ),
);
if (reviewed === undefined) fail("pull request head lacks a converged forge-cli review checkpoint");

process.stdout.write(`${JSON.stringify({
  ok: true,
  repository,
  commit,
  pull_request: pullRequest.number,
  reviewed_head: pullRequest.head.sha,
  review_digest: reviewed.record_digest,
})}\n`);
