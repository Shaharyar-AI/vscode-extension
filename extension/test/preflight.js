#!/usr/bin/env node
/**
 * Publish preflight.
 *
 * Everything that is cheap to check and expensive to get wrong. A rejected
 * publish is recoverable; a published-and-broken version is not — the
 * marketplace has no unpublish for a single version, only a version bump.
 *
 *   node test/preflight.js
 */

const fs = require("node:fs");
const path = require("node:path");

const DIR = path.resolve(__dirname, "..");
const p = JSON.parse(fs.readFileSync(path.join(DIR, "package.json"), "utf8"));

let fail = 0, warn = 0;
const c = (code, s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const ok = (m, d) => console.log(`  ${c("32", "ok  ")} ${m}${d ? c("2", "  " + d) : ""}`);
const no = (m, d) => { fail++; console.log(`  ${c("31", "FAIL")} ${m}\n         ${c("31", d)}`); };
const hm = (m, d) => { warn++; console.log(`  ${c("33", "warn")} ${m}${d ? c("2", "  " + d) : ""}`); };
const has = (f) => fs.existsSync(path.join(DIR, f));

console.log(c("1", "\nPublish preflight\n"));

// ── blockers ─────────────────────────────────────────────────────────────
console.log("Manifest");
p.private ? no("`private` must be removed", "vsce refuses to publish a private package") : ok("not marked private");
p.publisher ? ok("publisher", p.publisher) : no("publisher is missing", "must match your marketplace publisher ID exactly");
p.name ? ok("name", p.name) : no("name is missing", "");
p.version ? ok("version", p.version) : no("version is missing", "");
p.license ? ok("license", p.license) : hm("no license field", "");
p.repository?.url ? ok("repository", p.repository.url) : hm("no repository field", "vsce warns; listing has no source link");
p.engines?.vscode ? ok("engines.vscode", p.engines.vscode) : no("engines.vscode is missing", "");
Array.isArray(p.categories) && p.categories.length ? ok("categories", p.categories.join(", ")) : hm("no categories", "");
Array.isArray(p.keywords) && p.keywords.length ? ok("keywords", `${p.keywords.length}`) : hm("no keywords", "hurts discoverability");

console.log("\nFiles");
has("LICENSE") ? ok("LICENSE") : hm("no LICENSE file", "vsce warns");
has("CHANGELOG.md") ? ok("CHANGELOG.md") : hm("no CHANGELOG.md", "shown as a tab on the listing");

if (!p.icon) {
  hm("no icon", "the listing gets a grey placeholder");
} else if (!has(p.icon)) {
  no(`icon missing on disk: ${p.icon}`, "");
} else {
  const b = fs.readFileSync(path.join(DIR, p.icon));
  const png = b.length > 24 && b.readUInt32BE(0) === 0x89504e47;
  if (!png) {
    no("icon must be a PNG", `${p.icon} is not a PNG`);
  } else {
    const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
    w >= 128 && h >= 128 ? ok("icon", `${w}x${h} PNG`) : no("icon too small", `${w}x${h}, need at least 128x128`);
  }
}

const readme = has("README.md") ? fs.readFileSync(path.join(DIR, "README.md"), "utf8") : "";
if (!readme) no("README.md is missing", "it is the listing's product page");
else if (readme.length < 400) hm("README is very short", `${readme.length} chars — this is your product page`);
else ok("README.md", `${(readme.length / 1024).toFixed(1)} KB`);

// ── the thing that silently breaks installs ──────────────────────────────
console.log("\nBundled assets");
has("dist/extension.js") ? ok("bundle built") : no("dist/extension.js missing", "run: npm run build");
has("resources/references/ruleset.md")
  ? ok("ruleset bundled")
  : no("resources/references/ruleset.md missing", "installs would review with no ruleset — run: npm run build");
has("resources/references/lang/typescript.md")
  ? ok("language guides bundled")
  : no("language guides missing", "run: npm run build");

// ── version discipline ───────────────────────────────────────────────────
console.log("\nVersion");
const changelog = has("CHANGELOG.md") ? fs.readFileSync(path.join(DIR, "CHANGELOG.md"), "utf8") : "";
changelog.includes(p.version)
  ? ok(`CHANGELOG mentions ${p.version}`)
  : hm(`CHANGELOG has no entry for ${p.version}`, "the listing will show stale notes");

console.log(
  `\n${fail ? c("31", `${fail} blocker(s)`) : c("32", "no blockers")}` +
    `   ${warn ? c("33", `${warn} warning(s)`) : "0 warnings"}\n`,
);
if (fail) {
  console.log("Fix the blockers above, then re-run.\n");
  process.exit(1);
}
console.log("Ready. Next:  npx vsce publish\n");
