#!/usr/bin/env node
/**
 * CR-Track QA suite.
 *
 * Drives the built extension bundle through real scenarios: real git repos,
 * real commits, real Claude CLI reviews, a real HTTP endpoint. Everything
 * except the pixels.
 *
 *   node test/qa.js            all scenarios
 *   node test/qa.js --fast     skip the ones that call the model
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { makeStub, install, loadExtension, makeContext } = require("./stub");

const EXT_DIR = path.resolve(__dirname, "..");
const BUNDLE = path.join(EXT_DIR, "dist", "extension.js");
const FAST = process.argv.includes("--fast");

let pass = 0, fail = 0, skip = 0;
const failures = [];

const c = (code, s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s) => c("2", s);

function section(name) { console.log(`\n${c("1;36", "── " + name)}`); }
function ok(name, detail) { pass++; console.log(`  ${c("32", "PASS")}  ${name}${detail ? dim("  " + detail) : ""}`); }
function bad(name, detail) { fail++; failures.push(`${name} — ${detail}`); console.log(`  ${c("31", "FAIL")}  ${name}\n          ${c("31", detail)}`); }
function skipped(name, why) { skip++; console.log(`  ${c("33", "SKIP")}  ${name}${dim("  " + why)}`); }
/**
 * `info` is shown when the check passes; `failDetail` when it fails. Keeping
 * them separate matters — a negative assertion's failure text ("SECRET LEAKED")
 * printed next to a PASS reads as a catastrophe to anyone skimming the output.
 */
function check(name, cond, info = "", failDetail = info || "condition was false") {
  cond ? ok(name, info) : bad(name, failDetail);
}

// ── repo helpers ─────────────────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "crtrack-qa-"));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function makeRepo(name, files = {}) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "config", "user.name", "QA Bot");
  git(dir, "config", "user.email", "qa@example.com");
  git(dir, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "README.md"), "# qa\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  try { git(dir, "branch", "-M", "main"); } catch { /* already main */ }
  write(dir, files);
  return dir;
}

function write(dir, files) {
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body, "utf8");
  }
}

/** Stage everything and commit it, the way a developer would. */
function commit(dir, message, files) {
  if (files) write(dir, files);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", message);
  return git(dir, "rev-parse", "HEAD").trim();
}

const NEWLINE = String.fromCharCode(10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for something to become true, rather than assuming a fixed delay was
 * enough.
 *
 * The extension logs its review outcome *before* awaiting delivery, so settle()
 * returns while the upload is still in flight. Any check that inspects what
 * delivery produced — a queued file, a POST received — is racing it, and a race
 * that usually wins is worse than one that always loses: it fails once in
 * twenty runs and gets dismissed as a blip.
 */
async function waitFor(predicate, seconds = 20) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return true;
    } catch {
      /* not ready yet */
    }
    await sleep(250);
  }
  return false;
}

/** Invoke a registered command the way the palette or a row action would. */
const run = (state, id, ...args) => state.commands.get(id)?.(...args);

/**
 * Dormant states are the only ones that put a reason after a separator, so this
 * is the marker rather than the word "inactive" — which the status bar
 * deliberately replaces with the specific cause.
 */
const isDormant = (state) => / · /.test(state.statusText);

/** A real Claude binary on this machine, to plant in a fake profile. */
function findRealClaude() {
  const roots = [path.join(os.homedir(), ".vscode", "extensions")];
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root); } catch { continue; }
    for (const e of entries.filter((d) => d.startsWith("anthropic.claude-code")).sort().reverse()) {
      const p = path.join(root, e, "resources", "native-binary", exe);
      if (fs.existsSync(p)) return p;
    }
  }
  for (const p of [path.join(os.homedir(), ".local", "bin", exe), "/usr/local/bin/claude"]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Activate the extension against a repo. Does NOT wait for a review. */
async function boot(repo, { answers, store } = {}) {
  const { vscode, state } = makeStub({ repo, answers });
  const restore = install(vscode);
  const ext = loadExtension(BUNDLE);
  const context = makeContext(EXT_DIR, store);
  await ext.activate(context);
  // Activation logs a few lines from promises it does not await. Letting them
  // land here means a test that clears the log afterwards really starts empty
  // — otherwise a late "Active on…" line looks like the watcher reacting.
  await sleep(1_200);
  return { ext, state, vscode, context, restore };
}

/**
 * Fire the reflog watcher the way the real file system would, then wait for
 * the review it triggers to finish.
 *
 * This is the whole product in one function: a commit lands, the watcher
 * notices, a review runs. If this stops working, nothing else matters.
 */
async function fireCommitWatcher(state, { waitSec = 300 } = {}) {
  for (const w of state.fileWatchers) {
    if (/logs\/HEAD|^HEAD$/.test(w.pattern)) w.fireChange({ fsPath: "logs/HEAD" });
  }
  return settle(state, waitSec);
}

/**
 * Every way a triggered check can end. Waiting on the status bar instead was a
 * race: between the watcher noticing a commit and the review announcing itself
 * the status still reads "watching", which looks exactly like "finished".
 */
const OUTCOME =
  /finding\(s\) in \d+s|Review failed|— skipping|not a commit, ignoring|Could not read commit|Reporting failed|Commit check failed/;

/** Wait for the trigger to reach a conclusion, whatever that conclusion is. */
async function settle(state, waitSec = 300) {
  const deadline = Date.now() + waitSec * 1000;
  while (Date.now() < deadline) {
    if (OUTCOME.test(logText(state))) {
      // Reporting happens after the outcome line; give it a moment to land so
      // the log a test reads is the complete one.
      await sleep(1_500);
      return true;
    }
    await sleep(250);
  }
  return false;
}

async function walkTree(state) {
  const p = state.treeView?.provider;
  if (!p) return [];
  const rows = [];
  const go = async (node, depth) => {
    for (const child of (await p.getChildren(node)) ?? []) {
      const item = await p.getTreeItem(child);
      rows.push({ depth, kind: child.kind, label: String(item.label), description: item.description, contextValue: item.contextValue, node: child });
      await go(child, depth + 1);
    }
  };
  await go(undefined, 0);
  return rows;
}

const findings = (state) => walkTree(state).then((r) => r.filter((x) => x.kind === "finding"));
const logText = (state) => state.logLines.join("\n");

/** Source with problems a reviewer should find. */
const BAD_SOURCE = `
export async function transfer(from: string, to: string, amount: any) {
  const rows = await db.query("SELECT * FROM accounts WHERE id = '" + from + "'");
  const balance = rows[0].balance;
  if (balance > amount) {
    await db.query("UPDATE accounts SET balance = balance - " + amount + " WHERE id = '" + from + "'");
    await db.query("UPDATE accounts SET balance = balance + " + amount + " WHERE id = '" + to + "'");
  }
  return true;
}
`;

// ═════════════════════════════════════════════════════════════════════════
(async () => {
  console.log(c("1", "\nCR-Track QA") + dim(`   bundle ${fs.existsSync(BUNDLE) ? "ok" : "MISSING"}   ${FAST ? "fast mode" : "full"}`));

  if (!fs.existsSync(BUNDLE)) {
    console.error("\nBuild first: npm run build\n");
    process.exit(2);
  }

  // ── 1. Startup guards ──────────────────────────────────────────────────
  section("1. Startup guards");
  {
    const plain = path.join(TMP, "plain-folder");
    fs.mkdirSync(plain, { recursive: true });
    const { state, restore } = await boot(plain);
    check("A folder with no repository goes dormant",
      isDormant(state), state.statusText);
    check("...and the status bar says why, without needing a hover",
      /not a git repo/i.test(state.statusText), state.statusText,
      `status text was "${state.statusText}" — a bare "inactive" sends people ` +
      "round a disable/reload loop that cannot help");
    check("...and the reason names the repository, not something vague",
      /no git repository/i.test(state.statusTooltip + logText(state)),
      "", `tooltip was "${state.statusTooltip}"`);
    check("...and does not spam the same reason on repeated rechecks", (() => {
      const before = state.logLines.filter((l) => /no git repository/i.test(l)).length;
      for (const h of state.windowStateHandlers) h({ focused: true });
      const after = state.logLines.filter((l) => /no git repository/i.test(l)).length;
      return after === before;
    })(), "logged once");
    restore();
  }
  {
    const { state, restore } = await boot(undefined);
    check("No folder open goes dormant rather than throwing",
      isDormant(state) && /no folder/i.test(state.statusText), state.statusText);
    restore();
  }

  // ── 2. Recovery ────────────────────────────────────────────────────────
  section("2. Recovery from dormant states");
  {
    const later = path.join(TMP, "repo-appears");
    fs.mkdirSync(later, { recursive: true });
    const { state, restore } = await boot(later);
    check("Watches for a repository appearing",
      state.fileWatchers.some((w) => /\.git\/HEAD/.test(w.pattern)),
      state.fileWatchers.map((w) => w.pattern).join(", "));
    check("Rechecks on window focus while inactive",
      state.windowStateHandlers.length > 0);

    // Hammer every trigger; a runaway loop shows up as unbounded log growth.
    const before = state.logLines.length;
    for (let i = 0; i < 40; i++) {
      for (const h of state.windowStateHandlers) h({ focused: true });
      for (const w of state.fileWatchers) w.fireCreate?.({ fsPath: ".git/HEAD" });
    }
    await sleep(1_500);
    check("80 recovery triggers do not run away",
      state.logLines.length - before < 20,
      `${state.logLines.length - before} new log lines`,
      `${state.logLines.length - before} new log lines — the throttle is not holding`);
    restore();
  }

  // ── 3. Hostile environments ────────────────────────────────────────────
  section("3. Hostile environments");
  {
    const repo = makeRepo("hostile");
    const realPath = process.env.PATH;
    // A VS Code window that did not inherit git on PATH is the single most
    // common way this extension "does nothing" on someone else's machine.
    const emptyDir = path.join(TMP, "empty-path");
    fs.mkdirSync(emptyDir, { recursive: true });
    process.env.PATH = emptyDir;
    try {
      const { state, restore } = await boot(repo);
      check("Git missing from PATH is still found, or reported precisely",
        !isDormant(state) || /git could not be used|no git repository/i.test(state.statusTooltip),
        state.statusText,
        `status "${state.statusText}" tooltip "${state.statusTooltip}"`);
      check("...and the log names the git binary it tried",
        /git\s*=|Git \d/.test(logText(state)), "logged",
        "the log does not say which git was used — undiagnosable");
      restore();
    } finally {
      process.env.PATH = realPath;
    }
  }

  section("3b. Claude only inside the editor extension");
  {
    // The machine that produced "no Claude CLI" while the developer had a
    // working Claude terminal: Claude Code was installed as an *editor
    // extension*, so the binary lives in the extension directory and there is
    // no `claude` on PATH at all.
    const home = path.join(TMP, "editor-only-home");
    const planted = path.join(
      home, ".vscode", "extensions", "anthropic.claude-code-9.9.9-test",
      "resources", "native-binary",
    );
    fs.mkdirSync(planted, { recursive: true });

    const exe = process.platform === "win32" ? "claude.exe" : "claude";
    const real = findRealClaude();
    if (!real) {
      skipped("A Claude bundled in the editor extension is found", "no CLI on this machine");
    } else {
      const target = path.join(planted, exe);
      // Hard link where possible — the binary is large and copying it per run
      // is a real cost on a full disk.
      try { fs.linkSync(real, target); } catch { fs.copyFileSync(real, target); }

      const repo = makeRepo("editor-only");
      const saved = { PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
      const gitDir = (saved.PATH || "")
        .split(path.delimiter)
        .find((p) => /git/i.test(p) && (fs.existsSync(path.join(p, "git.exe")) || fs.existsSync(path.join(p, "git"))));
      process.env.PATH = [gitDir].filter(Boolean).join(path.delimiter);
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      try {
        const { state, restore } = await boot(repo);
        check("A Claude bundled in the editor extension is found",
          /Claude CLI [0-9.]+ at .*claude-code/.test(logText(state)),
          "found in the extension directory",
          `resolved to: ${logText(state).match(/Claude CLI.*/)?.[0] ?? "nothing"}`);
        check("...so the extension activates rather than reporting no CLI",
          !isDormant(state), state.statusText);
        restore();
      } finally {
        process.env.PATH = saved.PATH;
        process.env.HOME = saved.HOME;
        process.env.USERPROFILE = saved.USERPROFILE;
      }
    }
  }

  // ── 4. Guides ──────────────────────────────────────────────────────────
  section("4. Guide resolution");
  {
    const bundled = path.join(EXT_DIR, "resources", "references");
    check("Guides are bundled next to the extension", fs.existsSync(bundled), bundled);
    check("...including the ruleset and the language guides",
      fs.existsSync(path.join(bundled, "ruleset.md")) &&
      fs.existsSync(path.join(bundled, "lang", "typescript.md")),
      "ruleset.md + lang/typescript.md");
  }

  // ── 5. The trigger ─────────────────────────────────────────────────────
  section("5. A commit triggers a review");
  {
    const repo = makeRepo("commit-trigger");
    const { state, restore } = await boot(repo);
    check("Activates on a real repository",
      !isDormant(state), state.statusText);
    check("...and says it is watching for commits",
      /watching/i.test(state.statusTooltip), state.statusTooltip);
    check("...and installs a reflog watcher",
      state.fileWatchers.some((w) => /logs\/HEAD/.test(w.pattern)),
      state.fileWatchers.map((w) => w.pattern).join(", "));

    if (FAST) {
      skipped("Commit-triggered review", "needs the model");
      restore();
    } else {
      const sha = commit(repo, "add transfer", { "src/payments.ts": BAD_SOURCE });
      const settled = await fireCommitWatcher(state);
      check("The review finished", settled, state.statusText, "still running after 5 minutes");

      const log = logText(state);
      check("The commit was detected",
        log.includes(sha.slice(0, 8)) || /new commit/i.test(log),
        sha.slice(0, 8),
        "the watcher never noticed the commit");

      const rows = await findings(state);
      check("Findings were produced", rows.length > 0,
        `${rows.length} finding(s)`, "no findings on deliberately bad code");
      check("...and are attached to the committed file",
        rows.length === 0 || (await walkTree(state)).some((r) => r.kind === "file" && /payments\.ts/.test(r.label)),
        "src/payments.ts");
      check("...and appear as diagnostics too",
        state.diagnostics.size > 0, `${state.diagnostics.size} file(s) with squiggles`);
      check("...and the status bar reports the outcome",
        /CR-Track \d+|pass-filled/.test(state.statusText), state.statusText);
      check("...and each finding carries a suggestion the developer can act on",
        rows.length === 0 || rows.every((r) => (r.node.finding.suggestion ?? "").length > 10),
        "all findings have suggestions",
        "some findings have no suggestion — a recommendation with no advice is noise");

      // A second identical trigger must not start a second review.
      for (const w of state.fileWatchers) {
        if (/logs\/HEAD/.test(w.pattern)) w.fireChange({});
      }
      await sleep(2_500);
      check("An unchanged HEAD does not trigger another review",
        !/reviewing/i.test(state.statusText),
        "ignored",
        `status became "${state.statusText}"`);
      restore();
    }
  }

  // ── 6. What must NOT trigger a review ──────────────────────────────────
  section("6. Non-commits and non-code are skipped");
  {
    const repo = makeRepo("skips");
    commit(repo, "second", { "a.ts": "export const a = 1;\n" });
    const { state, restore } = await boot(repo);
    state.logLines.length = 0;
    git(repo, "checkout", "-q", "HEAD~1");
    await fireCommitWatcher(state, { waitSec: 30 });
    check("A checkout is not treated as a commit",
      /not a commit, ignoring/i.test(logText(state)),
      "ignored",
      `a branch switch was not filtered — log: ${logText(state).slice(-300)}`);
    restore();
  }
  {
    const repo = makeRepo("docs-only");
    const { state, restore } = await boot(repo);
    state.logLines.length = 0;
    commit(repo, "docs", { "NOTES.md": "# notes\n" });
    await fireCommitWatcher(state, { waitSec: 60 });
    check("A commit with no source files is skipped",
      /no source files/i.test(logText(state)),
      "skipped",
      `a docs-only commit was not skipped — log: ${logText(state).slice(-300)}`);
    restore();
  }
  {
    const repo = makeRepo("merges");
    commit(repo, "base", { "a.ts": "export const a = 1;\n" });
    git(repo, "checkout", "-q", "-b", "side");
    commit(repo, "side change", { "b.ts": "export const b = 2;\n" });
    git(repo, "checkout", "-q", "main");
    commit(repo, "main change", { "c.ts": "export const c = 3;\n" });
    const { state, restore } = await boot(repo);
    state.logLines.length = 0;
    git(repo, "merge", "-q", "--no-ff", "-m", "merge side", "side");
    await fireCommitWatcher(state, { waitSec: 60 });
    check("A merge commit is skipped",
      /is a merge|not a commit, ignoring/i.test(logText(state)),
      "skipped",
      `a merge's combined diff was not filtered — log: ${logText(state).slice(-300)}`);
    restore();
  }

  {
    // The failure this guards against was seen in the wild: the watcher fired
    // on a repository whose HEAD had not moved, priming had not recorded a
    // SHA, and the extension reviewed a commit from the previous week.
    const repo = makeRepo("stale-head");
    const old = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    write(repo, { "src/old.ts": "export const old = 1;" });
    git(repo, "add", "-A");
    execFileSync("git", ["commit", "-qm", "an old commit"], {
      cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old },
    });

    const { state, restore } = await boot(repo);
    state.logLines.length = 0;
    // Fire without any commit having happened — the exact wild condition.
    for (const w of state.fileWatchers) {
      if (/logs[/]HEAD|^HEAD$/.test(w.pattern)) w.fireChange({});
    }
    await sleep(4000);
    check("A week-old HEAD is never reviewed",
      !/Reviewing [0-9a-f]{7}/.test(logText(state)),
      "ignored",
      `an existing commit was reviewed on a spurious trigger: ${logText(state).slice(-300)}`);
    restore();
  }

  {
    // The empty-repository case the freshness guard must not break: with no
    // commits at all there is no HEAD to prime from, but the first commit is
    // genuinely new and has to be reviewed.
    const repo = path.join(TMP, "first-commit");
    fs.mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q");
    git(repo, "config", "user.name", "QA Bot");
    git(repo, "config", "user.email", "qa@example.com");
    git(repo, "config", "commit.gpgsign", "false");

    const { state, restore } = await boot(repo);
    check("An empty repository still activates",
      !isDormant(state), state.statusText);
    check("...and says the first commit will be reviewed",
      /No commits yet/i.test(logText(state)), "primed as empty");

    if (FAST) {
      skipped("The very first commit is reviewed", "needs the model");
    } else {
      state.logLines.length = 0;
      commit(repo, "first ever commit", { "src/first.ts": BAD_SOURCE });
      await fireCommitWatcher(state);
      check("The very first commit in a repository is reviewed",
        /Reviewing [0-9a-f]{7}/.test(logText(state)),
        "reviewed",
        `the first commit was skipped: ${logText(state).slice(-300)}`);
    }
    restore();
  }

  section("6b. Several repositories in one window");
  {
    // The layout that produced "not a git repo" beside a Source Control panel
    // listing two of them: the workspace folder is a plain parent directory and
    // the repositories are inside it.
    const parent = path.join(TMP, "workspace-parent");
    fs.mkdirSync(parent, { recursive: true });
    for (const name of ["frontend", "backend"]) {
      const dir = path.join(parent, name);
      fs.mkdirSync(dir, { recursive: true });
      git(dir, "init", "-q");
      git(dir, "config", "user.name", "QA Bot");
      git(dir, "config", "user.email", "qa@example.com");
      git(dir, "config", "commit.gpgsign", "false");
      fs.writeFileSync(path.join(dir, "README.md"), "# " + name);
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", "init");
    }

    const { state, restore } = await boot(parent);
    check("A parent folder of repositories still activates",
      !isDormant(state), state.statusText,
      `went dormant on a folder containing two repositories: "${state.statusText}"`);
    check("...and reports how many it is watching",
      /2 repositories/.test(state.statusTooltip), state.statusTooltip);
    check("...and installs a watcher for each",
      state.fileWatchers.filter((w) => /logs\/HEAD/.test(w.pattern)).length === 2,
      `${state.fileWatchers.filter((w) => /logs\/HEAD/.test(w.pattern)).length} reflog watchers`);

    if (FAST) {
      skipped("A commit in the second repository is reviewed", "needs the model");
    } else {
      state.logLines.length = 0;
      // Deliberately the *second* one — the bug was that only the first counted.
      commit(path.join(parent, "backend"), "add transfer", { "src/payments.ts": BAD_SOURCE });
      await fireCommitWatcher(state);
      check("A commit in the second repository is reviewed",
        /Reviewing [0-9a-f]{7}/.test(logText(state)),
        "reviewed",
        `only the first repository was watched: ${logText(state).slice(-300)}`);
    }
    restore();
  }

  section("6c. Working through the findings");
  if (FAST) {
    skipped("Copy and mark-fixed", "needs a real review to have findings");
  } else {
    const repo = makeRepo("triage");
    const { state, restore } = await boot(repo);
    commit(repo, "add transfer", { "src/payments.ts": BAD_SOURCE });
    await fireCommitWatcher(state);

    const rows = await findings(state);
    check("There are findings to work through", rows.length >= 2, `${rows.length}`);

    if (rows.length >= 2) {
      const first = rows[0].node;
      const id = first.finding.id;

      // ---- copy ----------------------------------------------------------
      state.clipboard = "";
      await run(state, "crTrack.copyFinding", first);
      check("Copy puts the finding on the clipboard",
        state.clipboard.length > 40, `${state.clipboard.length} chars`);
      check("...naming the file and line",
        state.clipboard.includes(first.finding.file) &&
          state.clipboard.includes(String(first.finding.lineStart)),
        `${first.finding.file}:${first.finding.lineStart}`);
      check("...and including the suggestion, which is the actionable part",
        state.clipboard.includes(first.finding.suggestion.slice(0, 30)), "suggestion present");

      // ---- mark fixed -----------------------------------------------------
      const squigglesBefore = [...state.diagnostics.values()].flat().length;
      await run(state, "crTrack.markFixed", first);
      const after = await walkTree(state);
      const marked = after.find((r) => r.kind === "finding" && r.node.finding.id === id);
      check("Marking it fixed turns the row green",
        marked?.contextValue === "finding-fixed" && marked?.description === "fixed",
        `${marked?.contextValue} / ${marked?.description}`);
      check("...and the others stay open so the next one is obvious",
        after.filter((r) => r.kind === "finding" && r.contextValue === "finding-open").length ===
          rows.length - 1,
        `${rows.length - 1} still open`);
      check("...and the panel title shows progress",
        /1\/\d+ fixed/.test(state.treeView.title ?? ""), state.treeView.title);
      check("...and the badge counts what is left, not what was found",
        state.treeView.badge?.value === rows.length - 1,
        `badge ${state.treeView.badge?.value}`);
      const squigglesAfter = [...state.diagnostics.values()].flat().length;
      check("...and its squiggle is gone",
        squigglesAfter === squigglesBefore - 1,
        `${squigglesBefore} -> ${squigglesAfter}`);

      // ---- copy all skips what is done -----------------------------------
      state.clipboard = "";
      await run(state, "crTrack.copyAllFindings");
      check("Copy-all skips the ones already fixed",
        !state.clipboard.includes(first.finding.title),
        "fixed finding excluded",
        "a finding already marked fixed was copied again");

      // ---- clicking the row -----------------------------------------------
      state.opened.length = 0;
      await run(state, "crTrack.revealFinding", first);
      const went = state.opened[state.opened.length - 1];
      check("Clicking a finding opens the file it is about",
        !!went && went.path.split(path.sep).join("/").endsWith(first.finding.file),
        went?.path);
      check("...at the line it points at",
        went?.line === first.finding.lineStart - 1,
        `line ${went?.line} for finding line ${first.finding.lineStart}`);

      // ---- undo -----------------------------------------------------------
      await run(state, "crTrack.markNotFixed", first);
      const undone = (await walkTree(state)).find(
        (r) => r.kind === "finding" && r.node.finding.id === id,
      );
      check("Marking it not-fixed puts it back",
        undone?.contextValue === "finding-open", undone?.contextValue);
    }
    restore();
  }

  section("6d. Progress survives a window reload");
  if (FAST) {
    skipped("Reload persistence", "needs a real review to have findings");
  } else {
    const repo = makeRepo("reload");
    const first = await boot(repo);
    commit(repo, "add transfer", { "src/payments.ts": BAD_SOURCE });
    await fireCommitWatcher(first.state);

    const before = await findings(first.state);
    check("A review leaves a report on disk",
      fs.existsSync(path.join(repo, ".cr-track", "last-review.json")),
      ".cr-track/last-review.json");

    // Tick off the first two, the way someone working through the list would.
    const done = before.slice(0, 2).map((r) => r.node.finding.id);
    for (const row of before.slice(0, 2)) await run(first.state, "crTrack.markFixed", row.node);
    const savedState = first.context.store;
    first.restore();

    // ---- reload: brand new window, same workspace state ------------------
    const second = await boot(repo, { store: savedState });
    const after = await walkTree(second.state);
    const rows = after.filter((r) => r.kind === "finding");

    check("A reload brings the findings back without waiting for a commit",
      rows.length === before.length, `${rows.length} of ${before.length}`,
      "the panel was empty after reload — the developer loses their list");
    check("...with the ones already fixed still green",
      rows.filter((r) => r.contextValue === "finding-fixed").length === 2,
      `${rows.filter((r) => r.contextValue === "finding-fixed").length} green`);
    check("...exactly the ones that were ticked, not just any two",
      done.every((id) =>
        rows.find((r) => r.node.finding.id === id)?.contextValue === "finding-fixed"),
      "same findings");
    check("...and the title still shows the progress",
      /2\/\d+ fixed/.test(second.state.treeView.title ?? ""), second.state.treeView.title);
    check("...and fixed findings do not come back as squiggles",
      [...second.state.diagnostics.values()].flat().length === before.length - 2,
      `${[...second.state.diagnostics.values()].flat().length} squiggles`);

    const panelPath = path.join(repo, ".cr-track", "panel.json");
    check("The panel saves its own state, separate from the dashboard report",
      fs.existsSync(panelPath), ".cr-track/panel.json");

    // A finding carried over from an earlier commit lives only in panel state:
    // last-review.json describes one commit, by design. Restoring from the
    // report alone silently dropped everything carried forward.
    const panel = JSON.parse(fs.readFileSync(panelPath, "utf8"));
    const reportOnly = JSON.parse(
      fs.readFileSync(path.join(repo, ".cr-track", "last-review.json"), "utf8"),
    );
    panel.findings.push({
      id: "c1", file: "src/older.ts", lineStart: 4, lineEnd: 6,
      severity: "important", category: "correctness",
      title: "Carried over from an earlier commit",
      description: "d", suggestion: "s",
    });
    fs.writeFileSync(panelPath, JSON.stringify(panel), "utf8");
    check("...and the report still describes only its own commit",
      !JSON.stringify(reportOnly.findings).includes("Carried over from an earlier commit"),
      `${reportOnly.findings.length} finding(s) reported`,
      "carried findings leaked into the dashboard report and would inflate its counts");
    second.restore();

    const third = await boot(repo, { store: savedState });
    const carried = (await walkTree(third.state)).filter((r) => r.kind === "finding");
    check("A finding carried from an earlier commit survives a reload",
      carried.some((r) => r.node.finding.title === "Carried over from an earlier commit"),
      `${carried.length} row(s)`,
      "reloading dropped every finding carried over from a previous commit");
    check("...alongside this commit's own findings",
      carried.length === panel.findings.length, `${carried.length} of ${panel.findings.length}`);
    check("...with the ticked ones still green",
      carried.filter((r) => r.contextValue === "finding-fixed").length === 2,
      `${carried.filter((r) => r.contextValue === "finding-fixed").length} green`);
    third.restore();
  }

  section("6e. A fix confirmed by the reviewer turns the row green");
  {
    // Exercise the shipped bundle, not a separate build of the same source.
    const { vscode: stubbed } = makeStub({ repo: EXT_DIR });
    const undo = install(stubbed);
    const { reconcile } = loadExtension(BUNDLE);
    undo();
    const prior = (id, file, title) => ({
      id, file, title, lineStart: 10, lineEnd: 12,
      severity: "important", category: "correctness",
      description: "d", suggestion: "s",
    });

    const previous = [
      prior("f1", "src/a.ts", "Unchecked null dereference in the parser"),
      prior("f2", "src/a.ts", "Progress pruning evicts the newest entry"),
      prior("f3", "src/b.ts", "Timeout is shorter than the documented cold start"),
    ];

    // Only f1 was confirmed fixed by the reviewer.
    const r = reconcile(previous, [], ["f1"]);
    check("The confirmed one is marked fixed", r.resolvedIds.join() === "f1", r.resolvedIds.join());
    check("...and the unconfirmed ones are not",
      !r.resolvedIds.includes("f2") && !r.resolvedIds.includes("f3"),
      "f2, f3 left open",
      "a finding went green without the reviewer confirming it");
    check("...while all three stay on the list",
      r.findings.length === 3, `${r.findings.length}`);

    // The dangerous case: silence must never be read as success.
    const silent = reconcile(previous, [], []);
    check("Nothing goes green when the reviewer confirms nothing",
      silent.resolvedIds.length === 0, "none",
      "absence from a review was treated as evidence of a fix");

    // A problem raised again replaces the old copy rather than doubling it.
    const again = reconcile(
      previous,
      [prior("n1", "src/a.ts", "Unchecked null dereference in the parser")],
      [],
    );
    check("A problem reported again appears once, not twice",
      again.findings.filter((f) => f.title.includes("null dereference")).length === 1,
      `${again.findings.length} total`);
    check("...and the fresh copy is the one kept",
      again.findings.some((f) => f.id === "n1") && !again.findings.some((f) => f.id === "f1"),
      "fresh copy kept");

    // Line numbers shift when a file is edited; identity must not depend on them.
    const moved = prior("n2", "src/a.ts", "Unchecked null dereference in the parser");
    moved.lineStart = 210;
    moved.lineEnd = 214;
    const shifted = reconcile(previous, [moved], []);
    check("A problem that moved down the file is still the same problem",
      shifted.findings.filter((f) => f.file === "src/a.ts").length === 2,
      `${shifted.findings.filter((f) => f.file === "src/a.ts").length} in src/a.ts`,
      "an edit that shifted line numbers duplicated the finding");

    // The collision that made ticking one finding green a different one:
    // every review re-numbers its findings from f1, so carried and fresh
    // findings arrive holding the same ids.
    const freshSameIds = [
      prior("f1", "src/new.ts", "Missing await on the write"),
      prior("f2", "src/new.ts", "Error is swallowed by the catch"),
    ];
    const merged = reconcile(previous, freshSameIds, []);
    const ids = merged.findings.map((f) => f.id);
    check("Merged findings all have distinct ids",
      new Set(ids).size === ids.length, ids.join(","),
      "two findings share an id — ticking one marks the other fixed");
    check("...with the fresh ones keeping the ids the report used",
      merged.findings.filter((f) => f.file === "src/new.ts").map((f) => f.id).join(",") === "f1,f2",
      "f1,f2");
    check("...and nothing lost in the renaming",
      merged.findings.length === 5, `${merged.findings.length} of 5`);

    // A confirmed fix must follow its finding through the renaming.
    const renamed = reconcile(previous, freshSameIds, ["f2"]);
    const green = renamed.findings.find((f) => renamed.resolvedIds.includes(f.id));
    check("A confirmed fix marks the finding it was about, not one that took its id",
      green?.title === "Progress pruning evicts the newest entry",
      green?.title || "(none)",
      "the wrong finding turned green after ids were made unique");

    // Same words, different file, is a different problem.
    const elsewhere = reconcile(
      previous,
      [prior("n3", "src/zzz.ts", "Unchecked null dereference in the parser")],
      [],
    );
    check("The same wording in another file is a separate problem",
      elsewhere.findings.length === 4, `${elsewhere.findings.length}`);
  }

  section("6f. The ingest token and how rejections are handled");
  if (FAST) {
    skipped("Token and rejection handling", "needs a live review to post");
  } else {
    const http = require("node:http");

    // A stand-in for the production dashboard: bearer auth first, then schema.
    const seen = [];
    let mode = "ok";
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const auth = req.headers["authorization"] || "";
        seen.push({ auth, body });
        const send = (code, obj) => {
          res.writeHead(code, { "content-type": "application/json" });
          res.end(JSON.stringify(obj));
        };
        if (mode === "unauthorized" || !/^Bearer .+/.test(auth)) {
          return send(401, { error: "unauthorized — unknown or revoked token" });
        }
        if (mode === "invalid") {
          return send(422, {
            error: "invalid payload",
            details: ["schemaVersion must be 2.x", "review.id is required"],
          });
        }
        let parsed = {};
        try { parsed = JSON.parse(body); } catch { /* reported below */ }
        send(200, { ok: true, reviewId: parsed?.review?.id });
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const endpoint = `http://127.0.0.1:${server.address().port}/api/ingest`;

    const repo = makeRepo("ingest");
    git(repo, "remote", "add", "origin", "https://github.com/ikonic-git-admin/some-repo.git");
    fs.writeFileSync(path.join(repo, ".cr-track.yaml"), `endpoint: ${endpoint}
`);
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "point at the test server");

    // Answers are scripted up front, the way every other dialog test here does
    // it. The padding is deliberate: a pasted token usually carries whitespace.
    const { state, context, restore } = await boot(repo, {
      answers: { input: ["  tok_abc123  "] },
    });

    // ---- storing a token --------------------------------------------------
    await run(state, "crTrack.setIngestToken");
    check("Setting a token stores it in secret storage",
      context.store.get("secret:crTrack.ingestToken") === "tok_abc123",
      JSON.stringify(context.store.get("secret:crTrack.ingestToken")),
      "the token was not stored, or was stored with surrounding whitespace");
    check("...and it is asked for as a password, not plain text",
      state.inputOptions[state.inputOptions.length - 1]?.password === true,
      `password: ${state.inputOptions[state.inputOptions.length - 1]?.password}`,
      "the token is echoed on screen while being typed");
    check("...and never lands in settings, which get committed",
      !JSON.stringify([...context.store.keys()]).includes("configuration"),
      "secret storage only");

    // ---- it is actually sent ---------------------------------------------
    seen.length = 0;
    commit(repo, "add transfer", { "src/payments.ts": BAD_SOURCE });
    await fireCommitWatcher(state);
    const posted = seen[seen.length - 1];
    check("The token is sent as a bearer header",
      posted?.auth === "Bearer tok_abc123",
      posted ? JSON.stringify(posted.auth) : "(no request reached the server)");
    check("...alongside a schema 2.x payload",
      /^2\./.test(JSON.parse(posted.body).schemaVersion), JSON.parse(posted.body).schemaVersion);
    check("...carrying repository.repo qualified by its owner",
      String(JSON.parse(posted.body).repository?.repo || "").includes("/"),
      JSON.parse(posted.body).repository?.repo || "(absent)",
      "repository.repo is a bare name, which collides across organisations");

    restore();

    // ---- how the two unretryable rejections are handled -------------------
    //
    // Driven through the transport directly rather than a full commit review:
    // these are properties of delivery, and three more live reviews would add
    // minutes to the suite to prove nothing extra.
    const { deliver } = require(path.join(EXT_DIR, "..", "engine", "dist", "telemetry.js"));
    const report = JSON.parse(
      fs.readFileSync(path.join(repo, ".cr-track", "last-review.json"), "utf8"),
    );
    const queueDir = path.join(repo, ".cr-track", "queue");
    const queued = () => (fs.existsSync(queueDir) ? fs.readdirSync(queueDir).length : 0);

    mode = "unauthorized";
    const beforeAuth = queued();
    const authResult = await deliver(repo, report, { endpoint, token: "revoked" });
    check("A rejected token is reported as an auth problem",
      authResult.permanentFailure === "auth", String(authResult.permanentFailure));
    check("...and is not queued for retry",
      authResult.queued === false && queued() === beforeAuth,
      `queue ${beforeAuth} -> ${queued()}`,
      "reports pile up in a queue that can never drain");

    mode = "invalid";
    const beforeInvalid = queued();
    const badResult = await deliver(repo, report, { endpoint, token: "tok_abc123" });
    check("A malformed payload is reported as a payload problem",
      badResult.permanentFailure === "payload", String(badResult.permanentFailure));
    check("...and is not queued either",
      badResult.queued === false && queued() === beforeInvalid,
      `queue ${beforeInvalid} -> ${queued()}`);
    check("...and every reason the server gave is kept",
      (badResult.details || []).join(" | ").includes("schemaVersion must be 2.x") &&
        (badResult.details || []).join(" | ").includes("review.id is required"),
      (badResult.details || []).join(" | ") || "(none)",
      "the server said exactly what was wrong and we discarded it");

    // A real outage must still queue — that is what the queue is for.
    mode = "ok";
    server.close();
    await sleep(200);
    const beforeDown = queued();
    const downResult = await deliver(repo, report, { endpoint, token: "tok_abc123" });
    check("A dashboard that is merely down still queues for retry",
      downResult.queued === true && queued() === beforeDown + 1,
      `queue ${beforeDown} -> ${queued()}`,
      "a transient outage now loses reports");

  }

  // ── 7. The report ──────────────────────────────────────────────────────
  section("7. The report reaches the dashboard");
  {
    const received = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (ch) => (body += ch));
      req.on("end", () => {
        received.push({ headers: req.headers, body });
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const endpoint = `http://127.0.0.1:${server.address().port}/api/ingest`;

    if (FAST) {
      skipped("Report delivery", "needs the model");
    } else {
      const repo = makeRepo("reporting");
      write(repo, { ".cr-track.yaml": `endpoint: ${endpoint}\nprofile: chill\n` });
      git(repo, "add", "-A"); git(repo, "commit", "-qm", "config");

      const { state, restore } = await boot(repo);
      commit(repo, "leaky change", {
        "src/api.ts": `const AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY123";\n${BAD_SOURCE}`,
      });
      await fireCommitWatcher(state);

      // The status bar flips to "reviewed" before the report is uploaded — the
      // developer should never wait on telemetry — so settling is not the same
      // as having delivered.
      const postDeadline = Date.now() + 20_000;
      while (!received.length && Date.now() < postDeadline) await sleep(500);

      await waitFor(() => received.length > 0);
      check("A report was POSTed", received.length > 0,
        `${received.length} request(s)`, "the dashboard was never called");

      if (received.length) {
        let payload = null;
        try { payload = JSON.parse(received[received.length - 1].body); } catch { /* reported below */ }
        check("...and it is valid JSON", !!payload);
        if (payload) {
          check("...with the source string the dashboard validates",
            payload.source === "claude-code-skill", payload.source,
            `source was "${payload.source}" — the dashboard rejects anything else`);
          check("...and a schemaVersion", ["1.0", "2.0"].includes(payload.schemaVersion), payload.schemaVersion);
          check("...and mode 'committed'", payload.review?.mode === "committed", payload.review?.mode);
          check("...and the commit it reviewed",
            !!payload.review?.commit?.sha && !!payload.review?.commit?.message,
            payload.review?.commit?.shortSha,
            "the commit block is missing — the dashboard cannot attribute the review");
          check("...and the commit author",
            /@/.test(payload.review?.commit?.authorEmail ?? ""), payload.review?.commit?.authorEmail);
          check("...and a developer identity", /@/.test(payload.developer?.email ?? ""), payload.developer?.email);
          check("...and a changes array", Array.isArray(payload.changes), `${payload.changes?.length} entries`);
          check("...and findings", Array.isArray(payload.findings), `${payload.findings?.length} findings`);
          check("...and a summary object", !!payload.summary && typeof payload.summary === "object");

          const raw = received[received.length - 1].body;
          check("The AWS secret never left the machine",
            !raw.includes("wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY123"),
            "redacted",
            "SECRET LEAKED — the AWS key appeared verbatim in the payload");
        }
      }

      check("A local copy is always written",
        fs.existsSync(path.join(repo, ".cr-track", "last-review.json")),
        ".cr-track/last-review.json");
      restore();
    }
    server.close();
  }

  // ── 8. A dead dashboard never costs the developer anything ─────────────
  section("8. Dashboard failure queues, never blocks");
  if (FAST) {
    skipped("Failure queue", "needs the model");
  } else {
    const repo = makeRepo("offline");
    // Port 1 is reliably refused.
    write(repo, { ".cr-track.yaml": "endpoint: http://127.0.0.1:1/api/ingest\nprofile: chill\n" });
    git(repo, "add", "-A"); git(repo, "commit", "-qm", "config");

    const { state, restore } = await boot(repo);
    commit(repo, "change", { "src/x.ts": BAD_SOURCE });
    const settled = await fireCommitWatcher(state);
    check("The review still completes with the dashboard down", settled, state.statusText);
    check("...and the failure is explained, not swallowed",
      /unreachable|queued/i.test(logText(state)), "queued for retry",
      `log said nothing about the failed upload: ${logText(state).slice(-300)}`);
    const queueDir = path.join(repo, ".cr-track", "queue");
    const didQueue = await waitFor(
      () => fs.existsSync(queueDir) && fs.readdirSync(queueDir).length > 0,
    );
    check("...and the report is queued for retry", didQueue,
      didQueue ? `${fs.readdirSync(queueDir).length} queued` : "no queue dir after 20s");
    check("...and nothing was shown to the developer as an error",
      !state.messages.some((m) => m.kind === "error"), "silent");
    restore();
  }

  // ── 9. Uninstall ───────────────────────────────────────────────────────
  section("9. Deactivate leaves nothing behind");
  {
    const repo = makeRepo("teardown");
    const { ext, state, restore } = await boot(repo);
    const watchers = [...state.fileWatchers];
    ext.deactivate();
    check("deactivate() does not throw", true);
    check("...and disposes every file watcher",
      watchers.every((w) => w.disposed),
      `${watchers.length} disposed`,
      `${watchers.filter((w) => !w.disposed).length} watcher(s) left running`);
    check("...and the bundle compiles in a process-tree kill",
      /taskkill/.test(fs.readFileSync(BUNDLE, "utf8")),
      "taskkill /T /F is present",
      "nothing kills spawned CLI processes — an uninstall can fail on Windows");
    restore();
  }
  {
    // The real symptom the developer reported: leftover `claude` processes hold
    // handles inside the extension directory, so Windows refuses to delete it.
    if (process.platform !== "win32") {
      skipped("No orphaned CLI processes", "windows-only check");
    } else {
      // Match on the flag only CR-Track passes. Counting every `claude`
      // process would count the developer's own Claude Code session and fail
      // for a reason that has nothing to do with this extension.
      let orphans = 0;
      try {
        // Filter by name first: without it the query matches the very
        // PowerShell process running it, whose command line contains the flag.
        const script =
          "@(Get-CimInstance Win32_Process | " +
          "Where-Object { $_.Name -like 'claude*' -and " +
          "$_.CommandLine -like '*append-system-prompt-file*' }).Count";
        const out = execFileSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8" });
        orphans = parseInt(out.trim(), 10) || 0;
      } catch { orphans = 0; }
      check("No review processes left running after the suite",
        orphans === 0, "none",
        `${orphans} orphaned review process(es) — these are what block an uninstall`);
    }
  }

  // ── 10. Contribution surface ───────────────────────────────────────────
  section("10. Only the commands this version implements are contributed");
  {
    const pkg = JSON.parse(fs.readFileSync(path.join(EXT_DIR, "package.json"), "utf8"));
    const declared = pkg.contributes.commands.map((cmd) => cmd.command).sort();
    const repo = makeRepo("commands");
    const { state, restore } = await boot(repo);
    const registered = [...state.commands.keys()].sort();

    const undeclared = registered.filter((id) => !declared.includes(id));
    const unregistered = declared.filter((id) => !registered.includes(id));
    check("Every declared command is registered", unregistered.length === 0,
      `${declared.length} commands`, `missing at runtime: ${unregistered.join(", ")}`);
    check("Every registered command is declared", undeclared.length === 0,
      "", `registered but not in package.json: ${undeclared.join(", ")}`);
    check("No walkthrough is contributed", !pkg.contributes.walkthroughs,
      "removed with the setup flow");
    check("The dashboard endpoint is configurable",
      !!pkg.contributes.configuration.properties["crTrack.endpoint"], "crTrack.endpoint");
    restore();
  }

  // ── done ───────────────────────────────────────────────────────────────
  console.log(`\n${c("1", "Result")}  ${c("32", pass + " passed")}  ${fail ? c("31", fail + " failed") : "0 failed"}  ${skip ? c("33", skip + " skipped") : ""}`);
  if (failures.length) {
    console.log(c("31", "\nFailures:"));
    for (const f of failures) console.log("  · " + f);
  }
  console.log("");
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* windows handles */ }
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error("\nQA harness crashed:\n", err);
  process.exit(2);
});
