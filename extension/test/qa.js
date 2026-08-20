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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Activate the extension against a repo. Does NOT wait for a review. */
async function boot(repo, { answers } = {}) {
  const { vscode, state } = makeStub({ repo, answers });
  const restore = install(vscode);
  const ext = loadExtension(BUNDLE);
  const context = makeContext(EXT_DIR);
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
      /inactive/i.test(state.statusText), state.statusText);
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
      /inactive/i.test(state.statusText), state.statusText);
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
        !/inactive/i.test(state.statusText) || /git could not be used|no git repository/i.test(state.statusTooltip),
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
      !/inactive/i.test(state.statusText), state.statusText);
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
    check("...and the report is queued for retry",
      fs.existsSync(queueDir) && fs.readdirSync(queueDir).length > 0,
      fs.existsSync(queueDir) ? `${fs.readdirSync(queueDir).length} queued` : "no queue dir");
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
