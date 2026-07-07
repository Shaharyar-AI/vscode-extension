#!/usr/bin/env node
"use strict";

// CR-Track skill installer.
// Copies the bundled skill into a target Claude Code skills directory AND
// pre-authorizes the read-only/automatic commands the skill needs (git lookups
// and the dashboard upload) so Claude Code never re-prompts for them mid-review.
// Source-file edits are deliberately NOT pre-authorized — the skill still asks
// you to approve findings before any fix is applied. Zero deps, Node >=16.
//
//   npx cr-track-skill                  install into ./.claude/skills/cr-track
//                                       + ./.claude/settings.local.json perms
//   npx cr-track-skill --global         install into ~/.claude/skills/cr-track
//                                       + ~/.claude/settings.json perms
//   npx cr-track-skill --shared-permissions
//                                       write perms to ./.claude/settings.json
//                                       (committed/team-wide) instead of *.local
//   npx cr-track-skill --no-permissions skip the permission setup entirely
//   npx cr-track-skill --force          overwrite an existing install
//   npx cr-track-skill --help           usage

const fs = require("fs");
const os = require("os");
const path = require("path");

const PKG = require(path.join(__dirname, "..", "package.json"));
const SKILL_SRC = path.join(__dirname, "..", "skill");
const SKILL_NAME = "cr-track";

// The exact set of tool-permission rules the skill needs to run unattended.
// Intentionally excludes Edit/Write to source files: applying fixes stays gated
// behind the skill's approval step. `echo`/`date` are here because the skill
// chains its git lookups in compound `git ... && echo ...` commands, and Claude
// Code only auto-approves a compound when EVERY segment is allow-listed.
const PERMISSIONS = [
  "Bash(git rev-parse:*)", // preflight: repo check, branch, HEAD, toplevel
  "Bash(git config:*)", //    preflight: developer identity + remote URL
  "Bash(git diff:*)", //      collect: staged/HEAD/base diffs, name-only, numstat
  "Bash(hostname)", //        report: client.host
  "Bash(date:*)", //          report: ISO timestamps
  "Bash(echo:*)", //          enables the compound git lookups above
  "Bash(curl:*)", //          report: POST to the dashboard endpoint
  "Write(.cr-track/**)", //   report: write .cr-track/last-review.json
];

function parseArgs(argv) {
  const opts = {
    global: false,
    force: false,
    help: false,
    permissions: true,
    sharedPermissions: false,
  };
  for (const a of argv) {
    if (a === "--global" || a === "-g") opts.global = true;
    else if (a === "--force" || a === "-f") opts.force = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--no-permissions") opts.permissions = false;
    else if (a === "--shared-permissions") opts.sharedPermissions = true;
    else if (a === "init" || a === "install") continue; // optional verb
    else {
      console.error(`cr-track-skill: unknown argument "${a}"`);
      opts.help = true;
    }
  }
  return opts;
}

function printHelp() {
  console.log(`
cr-track-skill v${PKG.version} — install the CR-Track review skill for Claude Code

Usage:
  npx cr-track-skill [options]

Options:
  -g, --global            Install into ~/.claude/skills/cr-track (every repo)
                          and write permissions to ~/.claude/settings.json
  -f, --force             Overwrite an existing cr-track skill install
      --shared-permissions  Write permissions to .claude/settings.json (committed,
                          team-wide) instead of .claude/settings.local.json
      --no-permissions    Do not touch any settings file; just copy the skill
  -h, --help              Show this help

Default target is ./.claude/skills/cr-track in the current directory, and
permissions are written to ./.claude/settings.local.json (personal, gitignored).

The installer pre-authorizes only the skill's git lookups and dashboard upload —
applying fixes always still asks for your approval first.

After installing:
  1. Stage changes:  git add .
  2. In Claude Code: "review my staged changes"
`);
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

// Merge PERMISSIONS into a Claude Code settings file's permissions.allow array,
// preserving every other key and never adding a duplicate. Returns a result
// object describing what happened so main() can report it honestly.
function ensurePermissions(settingsPath) {
  const result = { path: settingsPath, added: [], already: [], error: null };

  let settings = {};
  if (fs.existsSync(settingsPath)) {
    const raw = fs.readFileSync(settingsPath, "utf8");
    if (raw.trim() !== "") {
      try {
        settings = JSON.parse(raw);
      } catch (err) {
        // Never clobber a file we can't parse — bail out and let the user add
        // the rules by hand.
        result.error = `existing ${path.basename(settingsPath)} is not valid JSON (${err.message})`;
        return result;
      }
    }
    if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
      result.error = `existing ${path.basename(settingsPath)} is not a JSON object`;
      return result;
    }
  }

  if (typeof settings.permissions !== "object" || settings.permissions === null) {
    settings.permissions = {};
  }
  if (!Array.isArray(settings.permissions.allow)) {
    settings.permissions.allow = [];
  }

  const allow = settings.permissions.allow;
  const have = new Set(allow);
  for (const rule of PERMISSIONS) {
    if (have.has(rule)) {
      result.already.push(rule);
    } else {
      allow.push(rule);
      have.add(rule);
      result.added.push(rule);
    }
  }

  if (result.added.length > 0) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  }
  return result;
}

function reportPermissions(result) {
  if (result.error) {
    console.log(
      `\n⚠ Skipped permission setup: ${result.error}.\n` +
        `  Add these rules to your settings file's "permissions.allow" manually:\n` +
        PERMISSIONS.map((r) => `    ${r}`).join("\n")
    );
    return;
  }
  if (result.added.length === 0) {
    console.log(`\n✓ Permissions already configured in ${result.path} (nothing to add).`);
    return;
  }
  console.log(
    `\n✓ Pre-authorized ${result.added.length} command pattern(s) in ${result.path}:\n` +
      result.added.map((r) => `    ${r}`).join("\n") +
      `\n  (git lookups + dashboard upload run without prompting; applying fixes still asks first.)`
  );
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  const baseDir = opts.global ? os.homedir() : process.cwd();
  const skillsRoot = path.join(baseDir, ".claude", "skills");
  const dest = path.join(skillsRoot, SKILL_NAME);

  if (fs.existsSync(dest) && !opts.force) {
    console.error(
      `\ncr-track-skill: "${dest}" already exists.\n` +
        `Re-run with --force to overwrite it.\n`
    );
    process.exit(1);
  }

  try {
    if (fs.existsSync(dest) && opts.force) {
      fs.rmSync(dest, { recursive: true, force: true });
    }
    copyDir(SKILL_SRC, dest);
  } catch (err) {
    console.error(`\ncr-track-skill: install failed — ${err.message}\n`);
    process.exit(1);
  }

  const where = opts.global ? "~/.claude/skills" : "./.claude/skills";
  console.log(`\n✓ CR-Track skill installed to ${where}/${SKILL_NAME}`);

  // Pre-authorize the skill's unattended commands (unless opted out). A failure
  // here must never fail the install — the skill still works, it just prompts.
  if (opts.permissions) {
    let settingsPath;
    if (opts.global) {
      settingsPath = path.join(os.homedir(), ".claude", "settings.json");
    } else if (opts.sharedPermissions) {
      settingsPath = path.join(baseDir, ".claude", "settings.json");
    } else {
      settingsPath = path.join(baseDir, ".claude", "settings.local.json");
    }
    try {
      reportPermissions(ensurePermissions(settingsPath));
    } catch (err) {
      console.log(
        `\n⚠ Could not write permissions (${err.message}). The skill still works; ` +
          `you'll just be prompted for git/curl during a review.`
      );
    }
  } else {
    console.log(`\n• Skipped permission setup (--no-permissions).`);
  }

  // For a project install, drop a .cr-track.yaml at the repo root (pointing at the
  // configured dashboard) if the repo doesn't already have one, so reviews upload
  // out of the box. Global installs have no single repo, so skip.
  if (!opts.global) {
    const cfgPath = path.join(baseDir, ".cr-track.yaml");
    const sample = path.join(SKILL_SRC, "cr-track.yaml.example");
    try {
      if (fs.existsSync(cfgPath)) {
        console.log(`\n• Kept your existing .cr-track.yaml (left untouched).`);
      } else if (fs.existsSync(sample)) {
        fs.copyFileSync(sample, cfgPath);
        console.log(`\n✓ Wrote .cr-track.yaml — reviews upload to the dashboard 'endpoint' set inside it.`);
      }
    } catch (err) {
      console.log(
        `\n⚠ Could not write .cr-track.yaml (${err.message}). ` +
          `Copy it by hand from ${where}/${SKILL_NAME}/cr-track.yaml.example.`
      );
    }
  }

  console.log(`
Next:
  1. Stage some changes:   git add .
  2. In Claude Code, say:  "review my staged changes"
       → git lookups and the dashboard upload run automatically;
         you approve which fixes get applied.
  (Edit .cr-track.yaml to change the dashboard 'endpoint' or review profile.)
`);
}

main();
