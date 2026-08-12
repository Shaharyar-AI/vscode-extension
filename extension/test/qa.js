#!/usr/bin/env node
/**
 * CR-Track QA suite.
 *
 * Drives the built extension bundle through real scenarios: real git repos,
 * real Claude CLI reviews, real file writes, a real HTTP endpoint. Everything
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

function makeRepo(name, files, { commitFirst = true } = {}) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "config", "user.name", "QA Bot");
  git(dir, "config", "user.email", "qa@example.com");
  git(dir, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "README.md"), "# qa\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  if (commitFirst) {
    try { git(dir, "branch", "-M", "main"); } catch { /* already main */ }
  }
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

const stage = (dir) => git(dir, "add", "-A");

/** Activate the extension against a repo and wait for the review to settle. */
async function boot(repo, { answers, waitSec = 240, expectReview = true } = {}) {
  const { vscode, state } = makeStub({ repo, answers });
  const restore = install(vscode);
  const ext = loadExtension(BUNDLE);
  const context = makeContext(EXT_DIR);
  await ext.activate(context);

  if (expectReview) {
    const deadline = Date.now() + waitSec * 1000;
    while (Date.now() < deadline) {
      const s = state.statusText;
      if (!/Reviewing/.test(s) && (state.diagnostics.size > 0 || /pass-filled|circle-slash/.test(s))) break;
      await sleep(500);
    }
  }
  return { ext, state, vscode, context, restore };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (state, id, ...args) => state.commands.get(id)?.(...args);

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

// ═════════════════════════════════════════════════════════════════════════
(async () => {
  console.log(c("1", "\nCR-Track QA") + dim(`   bundle ${fs.existsSync(BUNDLE) ? "ok" : "MISSING"}   ${FAST ? "fast mode" : "full"}`));

  if (!fs.existsSync(BUNDLE)) {
    console.error("\nBuild first: npm run build\n");
    process.exit(2);
  }

  // ── 1. Guard rails ─────────────────────────────────────────────────────
  section("1. Startup guards");
  {
    const notRepo = path.join(TMP, "plain-folder");
    fs.mkdirSync(notRepo, { recursive: true });
    const { state, restore, ext } = await boot(notRepo, { expectReview: false });
    check("non-git folder stays dormant", /inactive/i.test(state.statusTooltip), state.statusTooltip);
    check("no diagnostics published", state.diagnostics.size === 0);
    ext.deactivate(); restore();
  }
  {
    const repo = makeRepo("empty-repo", {});
    const { state, restore, ext } = await boot(repo, { expectReview: false });
    await sleep(1500);
    check("nothing staged → idle, no review", !/Reviewing/.test(state.statusText), state.statusText);
    ext.deactivate(); restore();
  }
  {
    const { state, restore, ext } = await boot(undefined, { expectReview: false });
    check("no folder open stays dormant", /inactive/i.test(state.statusTooltip), state.statusTooltip);
    ext.deactivate(); restore();
  }

  // ── 1b. Recovery ───────────────────────────────────────────────────────
  //
  // Both bugs that reached a tester were of this shape: a correct dormant
  // state that never recovered, and read as broken. The suite passed both
  // times because it asserted "stays dormant" and stopped there.
  section("1b. Recovery from dormant states");
  {
    const dir = path.join(TMP, "becomes-a-repo");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.html"), "<h1>hi</h1>\n");

    const { vscode, state } = makeStub({ repo: dir });
    const restore = install(vscode);
    const ext = loadExtension(BUNDLE);
    await ext.activate(makeContext(EXT_DIR));
    await sleep(800);

    check("plain folder starts dormant", /inactive/i.test(state.statusTooltip), state.statusTooltip);
    const watching = state.fileWatchers.some((w) => /\.git\/HEAD/.test(w.pattern));
    check("watches for a repository appearing", watching,
      state.fileWatchers.map((w) => w.pattern).join(", ") || "no watchers armed");
    check("offers a manual restart", state.commands.has("crTrack.restart"));

    // The developer runs `git init` — the exact scenario that looked broken.
    git(dir, "init", "-q");
    git(dir, "config", "user.name", "QA Bot");
    git(dir, "config", "user.email", "qa@example.com");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "init");
    for (const w of state.fileWatchers) w.fireCreate?.();
    await sleep(8000);

    check("recovers after git init, with no reload",
      state.logLines.some((l) => /Active on/.test(l)),
      "", `still dormant:\n${state.logLines.slice(-4).join("\n")}`);
    ext.deactivate(); restore();
  }
  {
    // Focus is the only signal for a CLI installed in another terminal.
    const dir = path.join(TMP, "focus-recheck");
    fs.mkdirSync(dir, { recursive: true });
    const { vscode, state } = makeStub({ repo: dir });
    const restore = install(vscode);
    const ext = loadExtension(BUNDLE);
    await ext.activate(makeContext(EXT_DIR));
    await sleep(600);

    check("listens for window focus while dormant", state.windowStateHandlers.length > 0,
      `${state.windowStateHandlers.length} handler(s)`);

    git(dir, "init", "-q");
    git(dir, "config", "user.name", "QA Bot");
    git(dir, "config", "user.email", "qa@example.com");
    for (const h of state.windowStateHandlers) h({ focused: true });
    await sleep(8000);

    check("focus triggers a recheck", state.logLines.some((l) => /rechecking|Active on/.test(l)),
      "", `no recheck happened:\n${state.logLines.slice(-4).join("\n")}`);
    ext.deactivate(); restore();
  }
  {
    // Asking for a review while inactive should retry, not just complain.
    const dir = path.join(TMP, "review-retries");
    fs.mkdirSync(dir, { recursive: true });
    const { vscode, state } = makeStub({ repo: dir });
    const restore = install(vscode);
    const ext = loadExtension(BUNDLE);
    await ext.activate(makeContext(EXT_DIR));
    await sleep(600);

    git(dir, "init", "-q");
    git(dir, "config", "user.name", "QA Bot");
    git(dir, "config", "user.email", "qa@example.com");
    await run(state, "crTrack.reviewStaged");
    await sleep(8000);

    check("Review Staged retries startup when inactive",
      state.logLines.some((l) => /Active on/.test(l)),
      "", `never came up:\n${state.logLines.slice(-4).join("\n")}`);
    ext.deactivate(); restore();
  }

  // ── 1c. Nothing staged ─────────────────────────────────────────────────
  section("1c. Nothing staged is explained, not silent");
  {
    const repo = makeRepo("unstaged-only", {});
    fs.writeFileSync(path.join(repo, "code.js"), "export function f(a){ return a.b.c }\n");
    // Deliberately NOT staged.
    const { state, restore, ext } = await boot(repo, { expectReview: false });
    await sleep(2500);

    check("status bar says so in its text, not just a tooltip",
      /nothing staged/i.test(state.statusText), state.statusText);
    check("tooltip counts the unstaged files",
      /file\(s\) changed but not staged/i.test(String(state.statusTooltip)),
      String(state.statusTooltip).split("\n")[0]);
    check("panel switches to the nothing-staged welcome",
      state.contexts.get("crTrack.nothingStaged") === true,
      `context = ${state.contexts.get("crTrack.nothingStaged")}`);
    check("log explains it", state.logLines.some((l) => /Nothing staged/.test(l)),
      "", state.logLines.slice(-3).join(" | "));
    check("a working-tree review is offered", state.commands.has("crTrack.reviewWorkingTree"));
    ext.deactivate(); restore();
  }
  {
    // A genuinely clean tree is a different thing and should read differently.
    const repo = makeRepo("truly-clean", {});
    const { state, restore, ext } = await boot(repo, { expectReview: false });
    await sleep(2000);
    check("a clean tree does not claim 'nothing staged'",
      !/nothing staged/i.test(state.statusText), state.statusText);
    ext.deactivate(); restore();
  }

  // ── 2. Guides ──────────────────────────────────────────────────────────
  section("2. Guide resolution");
  {
    const repo = makeRepo("guides-repo", { "a.ts": "export const a = 1;\n" });
    stage(repo);
    const { state, restore, ext } = await boot(repo, { expectReview: false });
    await sleep(1200);
    const line = state.logLines.find((l) => l.includes("Guides:"));
    check("guides resolved from the extension dir", Boolean(line), line ?? state.logLines.join(" | ").slice(0, 200));
    check("ruleset + language guides on disk",
      fs.existsSync(path.join(EXT_DIR, "resources", "references", "ruleset.md")) &&
      fs.existsSync(path.join(EXT_DIR, "resources", "references", "lang", "typescript.md")));
    ext.deactivate(); restore();
  }

  // ── 3. Config ──────────────────────────────────────────────────────────
  section("3. .cr-track.yaml");
  {
    const repo = makeRepo("config-repo", {
      "a.ts": "export const a = 1;\n",
      ".cr-track.yaml": [
        "# team settings",
        "profile: chill",
        "min_severity_to_report: important",
        "categories_enabled: [security, correctness]",
        "endpoint: http://127.0.0.1:9/api/ingest",
      ].join("\n"),
    });
    stage(repo);
    const { state, restore, ext } = await boot(repo, { expectReview: false });
    await sleep(1200);
    // The engine logs the effective model/effort; profile lands in the prompt.
    check("repo with a config file activates cleanly",
      state.logLines.some((l) => /Active on/.test(l)), state.logLines.slice(-3).join(" | "));
    ext.deactivate(); restore();
  }

  if (FAST) {
    section("model-backed scenarios");
    skipped("review, fixes, commit gate, reporting", "--fast");
    return summarise();
  }

  // ── 4. A real review ───────────────────────────────────────────────────
  section("4. Review a real diff");
  let reviewState, reviewRepo, reviewCtl;
  {
    reviewRepo = makeRepo("review-repo", {
      "src/db.ts":
        'import { Pool } from "pg";\n' +
        "const pool = new Pool();\n\n" +
        "export async function findUser(name: string) {\n" +
        '  const sql = "SELECT * FROM users WHERE name = \'" + name + "\'";\n' +
        "  const res = await pool.query(sql);\n" +
        "  return res.rows[0].email;\n" +
        "}\n",
      "src/util/parse.ts": "export function amount(raw: string) {\n  return parseInt(raw);\n}\n",
    });
    stage(reviewRepo);
    const t0 = Date.now();
    reviewCtl = await boot(reviewRepo);
    reviewState = reviewCtl.state;
    const secs = ((Date.now() - t0) / 1000).toFixed(0);

    const rows = await walkTree(reviewState);
    const f = rows.filter((r) => r.kind === "finding");
    check("review produced findings", f.length > 0, `${f.length} finding(s) in ${secs}s`);
    check("diagnostics published", reviewState.diagnostics.size > 0, `${reviewState.diagnostics.size} file(s)`);
    check("status bar reflects the result", /CR-Track \d+|pass-filled/.test(reviewState.statusText), reviewState.statusText);

    const folders = rows.filter((r) => r.kind === "folder").map((r) => r.label);
    const files = rows.filter((r) => r.kind === "file").map((r) => r.label);
    check("tree groups by folder", folders.length > 0, `folders: ${folders.join(", ") || "none"}`);
    check("both changed files present or reviewed", files.length >= 1, `files: ${files.join(", ")}`);

    const withPatch = f.filter((r) => r.contextValue === "finding-fixable");
    check("at least one finding carries an applicable patch", withPatch.length > 0,
      `${withPatch.length}/${f.length} fixable`);
    check("findings show id, severity, line and confidence",
      f.every((r) => /f\d+ · \w+ · line/.test(String(r.description))), String(f[0]?.description));
    check("tree badge counts open findings",
      reviewState.treeView?.badge?.value === f.length, JSON.stringify(reviewState.treeView?.badge));
  }

  // ── 5. Accept a fix ────────────────────────────────────────────────────
  section("5. Accept a fix (writes to disk)");
  {
    const f = (await findings(reviewState)).filter((r) => r.contextValue === "finding-fixable");
    if (f.length === 0) {
      skipped("apply a patch", "no fixable finding in this review");
    } else {
      const target = f[0];
      const file = target.node.finding.file;
      const before = fs.readFileSync(path.join(reviewRepo, file), "utf8");
      await run(reviewState, "crTrack.acceptFinding", target.node);
      const after = fs.readFileSync(path.join(reviewRepo, file), "utf8");

      check("file content changed on disk", before !== after, `${file}`);
      check("no error dialog raised", !reviewState.messages.some((m) => m.kind === "error"),
        JSON.stringify(reviewState.messages.filter((m) => m.kind === "error")));

      const rows = await findings(reviewState);
      const now = rows.find((r) => r.node.finding.id === target.node.finding.id);
      check("finding marked applied in the tree", now?.description === "applied", String(now?.description));
      check("resolved finding loses its inline actions", now?.contextValue === "finding-resolved", String(now?.contextValue));
      check("squiggle removed for the applied finding",
        !JSON.stringify([...reviewState.diagnostics.values()]).includes(target.node.finding.id),
        "", "the diagnostic is still published");
    }
  }

  // ── 6. Staleness guard ─────────────────────────────────────────────────
  section("6. Staleness guard");
  {
    const f = (await findings(reviewState)).filter(
      (r) => r.contextValue === "finding-fixable" && r.description !== "applied",
    );
    if (f.length === 0) {
      skipped("refuse a stale patch", "no remaining fixable finding");
    } else {
      const target = f[0];
      const abs = path.join(reviewRepo, target.node.finding.file);
      // Insert lines above the finding so its recorded range no longer matches.
      fs.writeFileSync(abs, "// shifted\n// shifted\n" + fs.readFileSync(abs, "utf8"), "utf8");
      const before = fs.readFileSync(abs, "utf8");
      reviewState.messages.length = 0;
      await run(reviewState, "crTrack.acceptFinding", target.node);
      const after = fs.readFileSync(abs, "utf8");

      check("stale patch is refused, file untouched", before === after);
      check("developer is warned about the change",
        reviewState.messages.some((m) => /changed since the review/i.test(m.message)),
        JSON.stringify(reviewState.messages.map((m) => m.message.slice(0, 60))));
    }
  }

  // ── 7. Reject ──────────────────────────────────────────────────────────
  section("7. Reject with a reason");
  {
    const open = (await findings(reviewState)).filter((r) => !["applied", "dismissed"].includes(String(r.description)));
    if (open.length === 0) {
      skipped("reject a finding", "nothing left open");
    } else {
      const target = open[0];
      reviewCtl.restore();
      // Re-arm the stub's input queue by driving the handler with a scripted answer.
      const id = target.node.finding.id;
      // The stub consumes from the queue created at boot; push a fresh answer.
      reviewState.inputs.length = 0;
      const { vscode } = makeStub({ repo: reviewRepo });
      void vscode;
      const restore2 = install(reviewCtl.vscode);
      // Patch the input queue in place for this one call.
      reviewCtl.vscode.window.showInputBox = async (opts) => {
        reviewState.inputs.push(opts?.title ?? "");
        return "intentional — validated upstream";
      };
      await run(reviewState, "crTrack.rejectFinding", target.node);
      restore2();

      const rows = await findings(reviewState);
      const now = rows.find((r) => r.node.finding.id === id);
      check("finding marked dismissed", now?.description === "dismissed", String(now?.description));
      check("a reason was requested", reviewState.inputs.length > 0);
      check("squiggle removed for the rejected finding",
        !JSON.stringify([...reviewState.diagnostics.values()]).includes(id));
    }
  }

  // ── 8. Cache ───────────────────────────────────────────────────────────
  section("8. Result cache");
  {
    const repo = makeRepo("cache-repo", { "x.ts": "export const x: any = JSON.parse('{}');\n" });
    stage(repo);
    const ctl = await boot(repo);
    const first = ctl.state.logLines.filter((l) => /Review complete/.test(l)).length;

    ctl.state.logLines.length = 0;
    await run(ctl.state, "crTrack.reviewStaged"); // force:true — should re-run
    const forced = ctl.state.logLines.some((l) => /Review complete|Cache hit/.test(l));
    check("first review completed", first > 0);
    check("manual re-review runs", forced, ctl.state.logLines.slice(-2).join(" | "));
    ctl.ext.deactivate(); ctl.restore();
  }

  // ── 8b. Supersede + cancel ─────────────────────────────────────────────
  section("8b. Superseding an in-flight review");
  {
    const repo = makeRepo("supersede-repo", { "s.ts": "export const s = eval('1');\n" });
    stage(repo);
    const { vscode, state } = makeStub({ repo });
    const restore = install(vscode);
    const ext = loadExtension(BUNDLE);
    await ext.activate(makeContext(EXT_DIR));

    // Wait until a review is genuinely in flight, then start another.
    for (let i = 0; i < 40 && !/Reviewing/.test(state.statusText); i++) await sleep(250);
    const wasRunning = /Reviewing/.test(state.statusText);

    write(repo, { "s.ts": "export const s = 1;\nexport const t: any = null;\n" });
    stage(repo);
    await run(state, "crTrack.reviewStaged");
    await sleep(1000);

    const log = state.logLines.join("\n");
    check("a review was in flight to supersede", wasRunning, "", "review never started, so nothing was superseded");
    check("the superseded run was cancelled or discarded",
      /Cancelling in-flight review|Discarded a superseded review/.test(log),
      "", `neither cancel nor discard appeared in the log:\n${state.logLines.slice(-6).join("\n")}`);

    // Cancel explicitly and confirm the extension settles rather than hanging.
    await run(state, "crTrack.cancelReview");
    await sleep(500);
    check("cancel leaves the extension responsive",
      typeof state.statusText === "string" && state.statusText.length > 0, state.statusText);
    ext.deactivate(); restore();
  }

  // ── 9. Commit gate ─────────────────────────────────────────────────────
  section("9. Commit gate");
  {
    const rows = await findings(reviewState);
    const blocking = rows.filter((r) => r.node.finding.severity === "blocking" && !["applied", "dismissed"].includes(String(r.description)));

    reviewState.messages.length = 0;
    const restore3 = install(reviewCtl.vscode);
    reviewCtl.vscode.window.showWarningMessage = async (message) => {
      reviewState.messages.push({ kind: "warning", message });
      return "Review them"; // decline the commit
    };
    await run(reviewState, "crTrack.reviewAndCommit");
    restore3();

    if (blocking.length > 0) {
      check("blocking findings prompt before committing",
        reviewState.messages.some((m) => /blocking issue/i.test(m.message)),
        JSON.stringify(reviewState.messages.map((m) => m.message.slice(0, 50))));
      check("declining the prompt does not commit",
        !reviewState.messages.some((m) => m.kind === "host-command" && m.message === "git.commit"),
        "", "git.commit was invoked despite declining");
    } else {
      check("no blockers → commit proceeds without a prompt",
        !reviewState.messages.some((m) => /blocking issue/i.test(m.message)));
    }
    reviewCtl.ext.deactivate(); reviewCtl.restore();
  }

  // ── 10. Reporting + webhook ────────────────────────────────────────────
  section("10. Report, redaction and webhook");
  {
    const received = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        received.push({ url: req.url, auth: req.headers.authorization, body });
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;

    const repo = makeRepo("report-repo", {
      // A planted secret must never reach the wire.
      "conf.ts": 'export const cfg = { apiKey: "sk_live_AAAABBBBCCCCDDDDEEEE1111" };\n',
      ".cr-track.yaml": `endpoint: http://127.0.0.1:${port}/api/ingest\n`,
    });
    stage(repo);

    const ctl = await boot(repo);
    const restore4 = install(ctl.vscode);
    ctl.vscode.window.showWarningMessage = async () => "Commit anyway";
    ctl.vscode.window.showInputBox = async () => "qa override";
    await run(ctl.state, "crTrack.reviewAndCommit");
    restore4();
    await sleep(1500);

    const local = path.join(repo, ".cr-track", "last-review.json");
    check("local report written", fs.existsSync(local), local);

    if (fs.existsSync(local)) {
      const report = JSON.parse(fs.readFileSync(local, "utf8"));
      // `source` is what the dashboard validates against; client.surface is
      // what actually produced the report.
      check("report has the envelope the dashboard requires",
        report.schemaVersion === "2.0" && report.source === "claude-code-skill" &&
        Array.isArray(report.findings) && Array.isArray(report.changes) &&
        typeof report.review?.id === "string" && report.review?.mode === "staged" &&
        typeof report.repository?.remote === "string" && typeof report.ruleset === "string",
        `source=${report.source} changes=${Array.isArray(report.changes)} surface=${report.client?.surface}`);
      check("developer identity captured",
        report.developer?.email === "qa@example.com", JSON.stringify(report.developer));
      check("diff stats captured",
        report.diffStats?.filesChanged >= 1, JSON.stringify(report.diffStats?.filesChanged));
      check("summary present", typeof report.summary?.findingsTotal === "number");
      const raw = JSON.stringify(report);
      check("planted secret is redacted", !raw.includes("sk_live_AAAABBBBCCCCDDDDEEEE1111"),
        "", "SECRET LEAKED INTO THE LOCAL REPORT");
    }

    check("webhook received the report", received.length > 0, `${received.length} POST(s)`);
    if (received.length) {
      check("POST hit the configured path", received[0].url === "/api/ingest", received[0].url);
      const sent = received[0].body;
      check("secret absent from the wire payload", !sent.includes("sk_live_AAAABBBBCCCCDDDDEEEE1111"),
        "", "SECRET LEAKED OVER HTTP");
    }
    ctl.ext.deactivate(); ctl.restore();
    server.close();
  }

  // ── 11. Webhook down → queue ───────────────────────────────────────────
  section("11. Webhook failure queues, never blocks");
  {
    const repo = makeRepo("queue-repo", {
      "y.ts": "export function y(a: any) { return a.b.c; }\n",
      ".cr-track.yaml": "endpoint: http://127.0.0.1:1/api/ingest\n", // nothing listening
    });
    stage(repo);
    const ctl = await boot(repo);
    const restore5 = install(ctl.vscode);
    ctl.vscode.window.showWarningMessage = async () => "Commit anyway";
    ctl.vscode.window.showInputBox = async () => "qa";
    await run(ctl.state, "crTrack.reviewAndCommit");
    restore5();
    await sleep(2500);

    check("local report still written", fs.existsSync(path.join(repo, ".cr-track", "last-review.json")));
    const qdir = path.join(repo, ".cr-track", "queue");
    const queued = fs.existsSync(qdir) ? fs.readdirSync(qdir).filter((f) => f.endsWith(".json")) : [];
    check("failed upload queued for retry", queued.length > 0, `${queued.length} queued`);
    check("failure logged, not thrown",
      ctl.state.logLines.some((l) => /queued for retry|upload failed/i.test(l)),
      ctl.state.logLines.slice(-2).join(" | "));
    ctl.ext.deactivate(); ctl.restore();
  }

  summarise();
})().catch((e) => {
  console.error("\nQA harness crashed —", e);
  process.exit(2);
});

function summarise() {
  console.log("\n" + "═".repeat(64));
  console.log(`  ${c("32", pass + " passed")}   ${fail ? c("31", fail + " failed") : "0 failed"}   ${skip} skipped`);
  console.log("═".repeat(64));
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  • ${f}`);
  }
  console.log(dim(`\nNot covered here: icon rendering, squiggle painting, menu placement,\nhover formatting, real git.commit. Those need a VS Code window.\n`));
  process.exit(fail ? 1 : 0);
}
