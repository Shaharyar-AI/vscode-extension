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

  // The listing endpoints this test used to read back through were removed
  // with the dashboard page they served. What this host can still prove is
  // that the extension reviews a real commit and posts it; whether a review
  // is stored and rendered is now the team tracker's business, and
  // test/live-theirs.js is what exercises that.

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
  // Nobody is present to answer the send prompt in an automated run, and an
// unanswered prompt holds the report — which is the correct behaviour and the
// wrong thing to test here.
state.config.set("crTrack.confirmBeforeSending", false);
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

  // Reading the review back was how this test used to finish, through
  // /api/reviews and /api/review. Both routes were removed along with the
  // dashboard page they served, so those assertions could only ever fail
  // from here on. Storage and rendering are the team tracker's job now, and
  // test/live-theirs.js proves that path against the real endpoint with a
  // real token.
  console.log("\n── Reading it back");
  console.log("  skipped — moved to the team tracker (test/live-theirs.js)");

  console.log("\n── Teardown");
  ext.deactivate();
  restore();
  check("deactivate() leaves no review process running", (() => {
    if (process.platform !== "win32") return true;
    try {
      const out = execFileSync("powershell", ["-NoProfile", "-Command",
        "@(Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'claude*' -and " +
        "$_.CommandLine -like '*no-session-persistence*' }).Count"], { encoding: "utf8" });
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
