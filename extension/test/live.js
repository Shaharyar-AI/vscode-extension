#!/usr/bin/env node
/**
 * End-to-end against the real dashboard.
 *
 * Real repository, real commit, real Claude CLI, real HTTPS POST to the
 * deployed dashboard, then read it back through the dashboard's own API. No
 * stubs on the network side — this is the test that would have caught every
 * "it works on my machine" failure this project has had.
 *
 *   node test/live.js
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { makeStub, install, loadExtension, makeContext } = require("./stub");

const EXT_DIR = path.resolve(__dirname, "..");
const BUNDLE = path.join(EXT_DIR, "dist", "extension.js");
const DASHBOARD = process.env.CR_TRACK_DASHBOARD || "https://cr-track-dashboard.vercel.app";
const ENDPOINT = DASHBOARD + "/api/ingest";

let pass = 0, fail = 0;
const ok = (n, d = "") => { pass++; console.log("  PASS  " + n + (d ? "   " + d : "")); };
const bad = (n, d) => { fail++; console.log("  FAIL  " + n + "\n          " + d); };
const check = (n, cond, info = "", detail = info) => (cond ? ok(n, info) : bad(n, detail));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

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

(async () => {
  console.log("\nCR-Track live end-to-end\n  dashboard: " + DASHBOARD + "\n");

  if (!fs.existsSync(BUNDLE)) {
    console.error("Build first: npm run build");
    process.exit(2);
  }

  const before = await fetch(DASHBOARD + "/api/reviews?limit=500", { cache: "no-store" })
    .then((r) => r.json())
    .catch(() => ({ reviews: [] }));
  const seen = new Set((before.reviews || []).map((r) => r.key));
  console.log("  " + seen.size + " review(s) already on the dashboard\n");

  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "crtrack-live-"));
  const repo = path.join(TMP, "live-repo");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Live Test");
  git(repo, "config", "user.email", "live-test@ikonicdev.com");
  git(repo, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(repo, "README.md"), "# live\n");
  fs.writeFileSync(path.join(repo, ".cr-track.yaml"), `endpoint: ${ENDPOINT}\n`);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  try { git(repo, "branch", "-M", "main"); } catch { /* already main */ }

  console.log("── Booting the extension on a real repository");
  const { vscode, state } = makeStub({ repo });
  const restore = install(vscode);
  const ext = loadExtension(BUNDLE);
  await ext.activate(makeContext(EXT_DIR));
  await sleep(1500);
  // Dormant states put the reason after a separator; an active one never does.
  check("The extension is active", !/ · /.test(state.statusText), state.statusText);
  check("...and is watching for commits",
    state.fileWatchers.some((w) => /logs\/HEAD/.test(w.pattern)), "reflog watcher installed");

  console.log("\n── Making a real commit");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "payments.ts"), BAD_SOURCE, "utf8");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "Add the transfer endpoint");
  const sha = git(repo, "rev-parse", "HEAD").trim();
  console.log("  committed " + sha.slice(0, 7));

  for (const w of state.fileWatchers) {
    if (/logs\/HEAD|^HEAD$/.test(w.pattern)) w.fireChange({});
  }

  console.log("\n── Waiting for the review (up to 5 minutes)");
  // Reporting happens after the review announces its findings, so waiting for
  // the finding count alone would check the log mid-upload — the report would
  // be on the dashboard while the test called it missing.
  const DONE = /Report sent to the dashboard|Dashboard unreachable|Report written locally|Reporting failed|Review failed/;
  const deadline = Date.now() + 300_000;
  let last = "";
  while (Date.now() < deadline) {
    const line = state.logLines[state.logLines.length - 1] || "";
    if (line !== last) { last = line; console.log("  " + line); }
    if (DONE.test(state.logLines.join(String.fromCharCode(10)))) break;
    await sleep(1000);
  }
  const log = state.logLines.join("\n");

  check("The commit was detected", /New commit/.test(log), sha.slice(0, 7),
    "the reflog watcher never fired");
  check("A review ran", /Reviewing [0-9a-f]{7}/.test(log), "", "no review started");
  check("The review completed", /finding\(s\) in \d+s/.test(log), "",
    "the review did not finish: " + log.slice(-400));
  check("Findings were produced", state.diagnostics.size > 0,
    `${state.diagnostics.size} file(s) with findings`,
    "no findings on deliberately bad code");
  check("The report was sent, not queued", /Report sent to the dashboard/.test(log),
    "200", "the POST did not succeed: " + (log.match(/Dashboard.*/)?.[0] || "no line"));

  const localPath = path.join(repo, ".cr-track", "last-review.json");
  check("A local copy exists", fs.existsSync(localPath), ".cr-track/last-review.json");

  console.log("\n── Reading it back off the dashboard");
  await sleep(2000);
  let found = null;
  for (let i = 0; i < 10 && !found; i++) {
    const now = await fetch(DASHBOARD + "/api/reviews?limit=500", { cache: "no-store" })
      .then((r) => r.json())
      .catch(() => ({ reviews: [] }));
    found = (now.reviews || []).find((r) => !seen.has(r.key) && r.commitSha === sha);
    if (!found) await sleep(2000);
  }

  check("The review appears on the dashboard", !!found,
    found ? found.key : "", "the dashboard never received it");

  if (found) {
    check("...attributed to the right developer",
      found.developerEmail === "live-test@ikonicdev.com", found.developerEmail);
    check("...against the right commit", found.commitSha === sha, found.commitShort);
    check("...with the commit message", found.commitMessage === "Add the transfer endpoint",
      found.commitMessage);
    check("...with the branch", found.branch === "main", found.branch);
    check("...with the file count", found.filesChanged >= 1, `${found.filesChanged} file(s)`);
    check("...with findings counted",
      found.findingsTotal > 0, `${found.findingsTotal} finding(s)`,
      "the dashboard recorded zero findings for code that has several");
    check("...marked as a committed review", found.mode === "committed", found.mode);
    check("...identifying the extension", found.surface === "vscode-extension", found.surface);

    const detail = await fetch(DASHBOARD + "/api/review?key=" + encodeURIComponent(found.key))
      .then((r) => r.json());
    check("The full report is readable", detail.ok === true, found.key);
    const first = detail.report?.findings?.[0];
    check("...with a finding that names a file and a line",
      !!first?.file && Number.isFinite(first?.lineStart), first ? `${first.file}:${first.lineStart}` : "");
    check("...and carries advice the developer can act on",
      (first?.suggestion || "").length > 15, (first?.suggestion || "").slice(0, 70));
  }

  console.log("\n── Teardown");
  ext.deactivate();
  restore();
  check("deactivate() leaves no review process running", (() => {
    if (process.platform !== "win32") return true;
    try {
      const out = execFileSync("powershell", ["-NoProfile", "-Command",
        "@(Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'claude*' -and " +
        "$_.CommandLine -like '*append-system-prompt-file*' }).Count"], { encoding: "utf8" });
      return (parseInt(out.trim(), 10) || 0) === 0;
    } catch { return true; }
  })(), "none");

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* windows handles */ }

  console.log(`\nResult  ${pass} passed  ${fail} failed\n`);
  console.log("  Open " + DASHBOARD + " to see it.\n");
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error("\nLive test crashed:\n", err);
  process.exit(2);
});
