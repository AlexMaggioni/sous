// Releases of sous. The three published packages, @sous/cli, @sous/engine and @sous/harnesses,
// always share one version, and CHANGELOG.md has a section for each.
//
//   node scripts/release.mjs bump <version>     set the version, date the changelog, commit, tag
//   node scripts/release.mjs check <tag>        refuse a tag that does not match the packages
//   node scripts/release.mjs notes <version>    print the changelog section of a version
//   node scripts/release.mjs formula <version> <sha256>   print the Homebrew formula
//
// `pnpm release <version>` runs bump. Pushing the tag starts .github/workflows/release.yml.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLISHED = ["cli", "engine", "harnesses"];
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

const manifest = (name) => join(ROOT, "packages", name, "package.json");
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();

function fail(message) {
  process.stderr.write(`release: ${message}\n`);
  process.exit(1);
}

/** The one version of the published packages. Fails when they differ. */
function currentVersion() {
  const versions = new Set(PUBLISHED.map((name) => readJson(manifest(name)).version));
  if (versions.size !== 1) fail(`the packages have different versions: ${[...versions].join(", ")}`);
  return [...versions][0];
}

/** The lines of CHANGELOG.md under "## <version>", up to the next "## ". */
function notes(version) {
  const lines = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8").split("\n");
  const start = lines.findIndex((line) => line.startsWith(`## ${version} `) || line === `## ${version}`);
  if (start < 0) return undefined;
  const end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
}

function bump(version) {
  if (!version || !SEMVER.test(version)) fail("give a version such as 0.2.0 or 0.2.0-rc.1");
  if (git("status", "--porcelain")) fail("the working tree has changes. Commit or remove them first.");
  if (git("tag", "--list", `v${version}`)) fail(`the tag v${version} exists already`);
  const changelog = join(ROOT, "CHANGELOG.md");
  const text = readFileSync(changelog, "utf8");
  const heading = new RegExp(`^## ${version.replaceAll(".", "\\.")} \\(unreleased\\)$`, "m");
  if (!heading.test(text)) fail(`CHANGELOG.md has no "## ${version} (unreleased)" section. Write what changed there first.`);
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(changelog, text.replace(heading, `## ${version} (${today})`));
  for (const name of PUBLISHED) {
    const file = manifest(name);
    const pkg = readJson(file);
    pkg.version = version;
    writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  }
  git("add", "CHANGELOG.md", ...PUBLISHED.map((name) => join("packages", name, "package.json")));
  git("commit", "-m", `Release ${version}`);
  git("tag", "-a", `v${version}`, "-m", `sous ${version}`);
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  process.stdout.write(`Tagged v${version} on ${branch}. Push it to publish:\n  git push origin ${branch} v${version}\n`);
}

function check(tag) {
  const version = currentVersion();
  if (tag !== `v${version}`) fail(`the tag ${tag} does not match the packages' version ${version}`);
  if (!SEMVER.test(version)) fail(`${version} is not a version`);
  if (!notes(version)) fail(`CHANGELOG.md has no section for ${version}`);
  process.stdout.write(`${version}\n`);
}

function formula(version, sha256) {
  if (!version || !/^[0-9a-f]{64}$/.test(sha256 ?? "")) fail("give a version and the sha256 of its npm tarball");
  const template = readFileSync(join(ROOT, "packaging", "homebrew", "sous.rb"), "utf8");
  process.stdout.write(template.replaceAll("{{version}}", version).replaceAll("{{sha256}}", sha256));
}

const [command, ...args] = process.argv.slice(2);
if (command === "bump") bump(args[0]);
else if (command === "check") check(args[0]);
else if (command === "notes") {
  const text = notes(args[0]);
  if (!text) fail(`CHANGELOG.md has no section for ${args[0]}`);
  process.stdout.write(`${text}\n`);
} else if (command === "formula") formula(args[0], args[1]);
else fail("use bump <version>, check <tag>, notes <version> or formula <version> <sha256>");
