import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type JsonObject = Record<string, any>;

export interface ReleasePlan {
  tag: string;
  package_name: string;
  version: string;
  workspace: string;
  tag_prefix: string;
  compatibility_peers: string[];
  smoke_module: string;
  package_files: string[];
  peer_dependencies: Record<string, string>;
  main: string;
  types: string;
}

function fail(message: string): never {
  throw new Error(`release package invalid: ${message}`);
}

function json(path: string): JsonObject {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function packageDirectories(root: string): string[] {
  const packageRoot = join(root, "packages");
  return readdirSync(packageRoot)
    .map((name) => join(packageRoot, name))
    .filter((path) => statSync(path).isDirectory() && existsSync(join(path, "package.json")))
    .sort();
}

function validatePackage(root: string, workspace: string, packageJson: JsonObject): Omit<ReleasePlan, "tag"> {
  const relativeWorkspace = `packages/${basename(workspace)}`;
  if (packageJson.private === true) fail(`${relativeWorkspace} is private`);
  if (!/^@sympoies\/[a-z0-9][a-z0-9-]*$/.test(packageJson.name ?? "")) {
    fail(`${relativeWorkspace} must use a public @sympoies package name`);
  }
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(packageJson.version ?? "")) {
    fail(`${relativeWorkspace} must own a stable SemVer version`);
  }
  if (packageJson.license !== "MIT") fail(`${relativeWorkspace} must declare the MIT license`);
  const repository = packageJson.repository;
  if (
    repository?.url !== "git+https://github.com/sympoies/dsh-plugins.git" ||
    repository?.directory !== relativeWorkspace
  ) fail(`${relativeWorkspace} repository identity is incomplete`);
  const requiredFiles = ["lib", "README.md", "LICENSE"];
  if (!Array.isArray(packageJson.files) || requiredFiles.some((entry) => !packageJson.files.includes(entry))) {
    fail(`${relativeWorkspace} files must include lib, README.md, and LICENSE`);
  }
  const packageFiles = packageJson.files as unknown[];
  for (const entry of packageFiles) {
    if (typeof entry !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(entry) || entry.includes("..") || entry.endsWith("/")) {
      fail(`${relativeWorkspace} files must contain safe literal paths`);
    }
  }
  const declaredPackageFiles = packageFiles as string[];
  for (const file of ["README.md", "LICENSE"]) {
    if (!existsSync(join(workspace, file))) fail(`${relativeWorkspace}/${file} is missing`);
  }
  if (!/^lib\/.+\.js$/.test(packageJson.main ?? "")) fail(`${relativeWorkspace} main must be a compiled lib entrypoint`);
  if (!/^lib\/.+\.d\.ts$/.test(packageJson.types ?? "")) fail(`${relativeWorkspace} types must be a compiled lib declaration`);
  const releasePath = join(workspace, "release/manifest.json");
  if (!existsSync(releasePath)) fail(`${relativeWorkspace}/release/manifest.json is missing`);
  const release = json(releasePath);
  if (release.schemaVersion !== "dsh-plugin-release.v2") fail(`${relativeWorkspace} release manifest schema is unsupported`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(release?.tagPrefix ?? "")) fail(`${relativeWorkspace} release tagPrefix is invalid`);
  const compatibilityPeers = release.compatibilityPeers;
  if (!Array.isArray(compatibilityPeers) || compatibilityPeers.length === 0 || compatibilityPeers.some((peer) => typeof peer !== "string")) {
    fail(`${relativeWorkspace} release compatibilityPeers must contain package names`);
  }
  if (new Set(compatibilityPeers).size !== compatibilityPeers.length) {
    fail(`${relativeWorkspace} release compatibilityPeers must be unique`);
  }
  const smokeModule = release.smokeModule;
  if (typeof smokeModule !== "string" || !/^release\/[A-Za-z0-9][A-Za-z0-9._-]*\.mjs$/.test(smokeModule)) {
    fail(`${relativeWorkspace} release smokeModule is invalid`);
  }
  if (!existsSync(join(workspace, smokeModule))) fail(`${relativeWorkspace}/${smokeModule} is missing`);
  if (declaredPackageFiles.some((entry) => entry === "release" || entry.startsWith("release/"))) {
    fail(`${relativeWorkspace} release files must be excluded from package files`);
  }
  const peers = packageJson.peerDependencies;
  if (peers === null || typeof peers !== "object" || Array.isArray(peers)) {
    fail(`${relativeWorkspace} peerDependencies must contain an object`);
  }
  for (const peer of compatibilityPeers) {
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(peers?.[peer] ?? "")) {
      fail(`${relativeWorkspace} must pin exact ${peer} compatibility`);
    }
  }
  for (const script of ["build", "test:coverage"]) {
    if (typeof packageJson.scripts?.[script] !== "string") fail(`${relativeWorkspace} is missing the ${script} script`);
  }
  return {
    package_name: packageJson.name,
    version: packageJson.version,
    workspace: relativeWorkspace,
    tag_prefix: release.tagPrefix,
    compatibility_peers: compatibilityPeers,
    smoke_module: smokeModule,
    package_files: declaredPackageFiles,
    peer_dependencies: peers,
    main: packageJson.main,
    types: packageJson.types,
  };
}

export function resolveReleasePlan(root: string, tag: string): ReleasePlan {
  const match = /^([a-z0-9][a-z0-9-]*)-v((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))$/.exec(tag);
  if (match === null) fail("tag must be <tagPrefix>-v<stable-semver>");
  const candidates = packageDirectories(root).map((workspace) =>
    validatePackage(root, workspace, json(join(workspace, "package.json"))),
  );
  const selected = candidates.filter((candidate) => candidate.tag_prefix === match[1]);
  if (selected.length !== 1) fail(`tag prefix must select exactly one workspace; found ${selected.length}`);
  const selectedPlan = selected[0];
  if (selectedPlan === undefined) fail("tag prefix selection disappeared");
  if (selectedPlan.version !== match[2]) fail(`tag version ${match[2]} does not match ${selectedPlan.package_name}@${selectedPlan.version}`);
  return { tag, ...selectedPlan };
}

export function validateInventory(plan: ReleasePlan, files: string[]): void {
  const required = ["package/package.json", "package/README.md", "package/LICENSE", `package/${plan.main}`, `package/${plan.types}`];
  for (const path of required) {
    if (!files.includes(path)) fail(`tarball is missing ${path}`);
  }
  const unexpected = files.filter((path) => {
    if (path === "package/package.json") return false;
    return !plan.package_files.some((entry) => path === `package/${entry}` || path.startsWith(`package/${entry}/`));
  });
  if (unexpected.length > 0) fail(`tarball contains unexpected files: ${unexpected.join(", ")}`);
}

function npmPack(root: string, plan: ReleasePlan, outDir: string, dryRun: boolean): JsonObject {
  const arguments_ = ["pack", "--ignore-scripts", "--json", "--workspace", plan.package_name];
  if (dryRun) arguments_.push("--dry-run");
  else arguments_.push("--pack-destination", outDir);
  const output = execFileSync("npm", arguments_, { cwd: root, encoding: "utf8" });
  const records = JSON.parse(output);
  if (!Array.isArray(records) || records.length !== 1) fail(`npm pack must produce one record; found ${records?.length ?? "invalid"}`);
  validateInventory(plan, records[0].files.map((entry: JsonObject) => `package/${entry.path}`));
  return records[0];
}

function verifyFreshBoot(root: string, plan: ReleasePlan, tarball: string): void {
  const profile = mkdtempSync(join(tmpdir(), "dsh-plugin-release-profile-"));
  try {
    const dependencies = { ...plan.peer_dependencies, [plan.package_name]: `file:${tarball}` };
    writeFileSync(join(profile, "package.json"), `${JSON.stringify({ private: true, type: "module", dependencies }, null, 2)}\n`);
    execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false"], {
      cwd: profile,
      stdio: "inherit",
    });
    writeFileSync(join(profile, "boot.mjs"), readFileSync(join(root, plan.workspace, plan.smoke_module)));
    execFileSync("node", ["boot.mjs"], { cwd: profile, stdio: "inherit" });
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}

function parseArguments(argv: string[]): { command: string; values: Map<string, string> } {
  const [command, ...rest] = argv;
  if (!command) fail("command is required");
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag?.startsWith("--") || value === undefined || values.has(flag)) fail("arguments must be unique --name value pairs");
    values.set(flag, value);
  }
  return { command, values };
}

function requireValue(values: Map<string, string>, flag: string): string {
  const value = values.get(flag);
  if (value === undefined) fail(`${flag} is required`);
  return value;
}

function main(): void {
  const root = resolve(import.meta.dirname, "..");
  const { command, values } = parseArguments(process.argv.slice(2));
  if (command === "plan") {
    const plan = resolveReleasePlan(root, requireValue(values, "--tag"));
    const output = values.get("--github-output");
    if (output !== undefined) {
      writeFileSync(output, Object.entries(plan).filter(([, value]) => typeof value === "string").map(([key, value]) => `${key}=${value}\n`).join(""), { flag: "a" });
    } else {
      process.stdout.write(`${JSON.stringify(plan)}\n`);
    }
    return;
  }
  if (command === "audit") {
    const packages = packageDirectories(root);
    for (const workspace of packages) {
      const packageJson = json(join(workspace, "package.json"));
      const prefix = json(join(workspace, "release/manifest.json")).tagPrefix;
      const plan = resolveReleasePlan(root, `${prefix}-v${packageJson.version}`);
      npmPack(root, plan, root, true);
    }
    process.stdout.write(`audited ${packages.length} releasable workspace(s)\n`);
    return;
  }
  if (command === "bootstrap") {
    const packageName = requireValue(values, "--package");
    const outDir = resolve(requireValue(values, "--out-dir"));
    const packages = packageDirectories(root).map((workspace) => ({
      workspace,
      packageJson: json(join(workspace, "package.json")),
    }));
    const selected = packages.filter(({ packageJson }) => packageJson.name === packageName);
    if (selected.length !== 1) fail(`--package must select exactly one workspace; found ${selected.length}`);
    const selectedPackage = selected[0];
    if (selectedPackage === undefined) fail("bootstrap workspace selection disappeared");
    validatePackage(root, selectedPackage.workspace, selectedPackage.packageJson);
    mkdirSync(outDir, { recursive: false });
    const staging = mkdtempSync(join(tmpdir(), "dsh-plugin-npm-bootstrap-"));
    try {
      writeFileSync(join(staging, "package.json"), `${JSON.stringify({
        name: packageName,
        version: "0.0.0-bootstrap.0",
        description: "Registry bootstrap for the sympoies/dsh-plugins OIDC trusted publisher",
        license: "MIT",
        repository: selectedPackage.packageJson.repository,
        publishConfig: { access: "public", tag: "bootstrap", registry: "https://registry.npmjs.org/" },
        files: ["README.md", "LICENSE"],
      }, null, 2)}\n`);
      writeFileSync(join(staging, "README.md"), `# ${packageName}\n\nRegistry bootstrap only. Install a stable release instead.\n`);
      writeFileSync(join(staging, "LICENSE"), readFileSync(join(root, "LICENSE")));
      const output = execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", outDir], {
        cwd: staging,
        encoding: "utf8",
      });
      const records = JSON.parse(output);
      if (!Array.isArray(records) || records.length !== 1) fail("bootstrap pack must produce exactly one tarball");
      const files = records[0].files.map((entry: JsonObject) => entry.path).sort();
      const expected = ["LICENSE", "README.md", "package.json"];
      if (JSON.stringify(files) !== JSON.stringify(expected)) fail(`bootstrap tarball inventory is unexpected: ${files.join(", ")}`);
      const archive = join(outDir, records[0].filename);
      const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
      writeFileSync(join(outDir, "SHA256SUMS"), `${digest}  ${records[0].filename}\n`);
      process.stdout.write(`${JSON.stringify({ ok: true, package: packageName, version: "0.0.0-bootstrap.0", archive, sha256: `sha256:${digest}` })}\n`);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    return;
  }
  if (command === "pack") {
    const plan = resolveReleasePlan(root, requireValue(values, "--tag"));
    const sourceCommit = requireValue(values, "--source-commit");
    if (!/^[0-9a-f]{40}$/.test(sourceCommit)) fail("--source-commit must be a full lowercase revision");
    const outDir = resolve(requireValue(values, "--out-dir"));
    mkdirSync(outDir, { recursive: false });
    const record = npmPack(root, plan, outDir, false);
    const tarball = join(outDir, record.filename);
    const digest = createHash("sha256").update(readFileSync(tarball)).digest("hex");
    writeFileSync(join(outDir, "SHA256SUMS"), `${digest}  ${record.filename}\n`);
    writeFileSync(join(outDir, "release-lock.json"), `${JSON.stringify({
      schema_version: "dsh-plugin-release-lock.v1",
      package: plan.package_name,
      version: plan.version,
      tag: plan.tag,
      source_commit: sourceCommit,
      archive: record.filename,
      sha256: `sha256:${digest}`,
      peer_dependencies: plan.peer_dependencies,
      node: "24.16.0",
      npm: "11.6.2",
    }, null, 2)}\n`);
    verifyFreshBoot(root, plan, tarball);
    process.stdout.write(`${JSON.stringify({ ok: true, archive: tarball, sha256: `sha256:${digest}` })}\n`);
    return;
  }
  fail(`unknown command: ${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
