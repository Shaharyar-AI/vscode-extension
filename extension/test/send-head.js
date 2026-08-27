/**
 * Review the current HEAD of this repository and send it to the tracker.
 *
 * The real extension bundle, the real Claude CLI, the real endpoint. The token
 * comes from the environment and is stored the way the extension stores it, so
 * this exercises the same path a developer's commit takes.
 */
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const { makeStub, install, loadExtension, makeContext } = require("./stub");

const EXT_DIR = path.resolve(__dirname, "..");
const REPO = path.resolve(EXT_DIR, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const token = process.env.CRT_T;
  if (!token) { console.error("Set CRT_T."); process.exit(2); }

  const sha = cp.execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const subject = cp.execFileSync("git", ["-C", REPO, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim();
  console.log(`\nReviewing ${sha.slice(0, 7)} — ${subject}\n`);

  const { vscode, state } = makeStub({ repo: REPO });
  // Nobody is present to answer the send prompt in an automated run, and an
// unanswered prompt holds the report — which is the correct behaviour and the
// wrong thing to test here.
state.config.set("crTrack.confirmBeforeSending", false);
const restore = install(vscode);
  const ext = loadExtension(path.join(EXT_DIR, "dist", "extension.js"));
  const context = makeContext(EXT_DIR);
  await ext.activate(context);
  await context.secrets.store("crTrack.ingestToken", token);
  await sleep(1500);

  for (const w of state.fileWatchers) {
    if (/logs\/HEAD|^HEAD$/.test(w.pattern)) w.fireChange({ fsPath: "logs/HEAD" });
  }

  const DONE = /Report sent to the dashboard|Dashboard unreachable|rejected the report|Reporting failed|Review failed|— skipping/;
  const deadline = Date.now() + 600_000;
  let last = "";
  while (Date.now() < deadline) {
    const line = state.logLines[state.logLines.length - 1] || "";
    if (line !== last) { last = line; console.log("  " + line); }
    if (DONE.test(state.logLines.join("\n"))) break;
    await sleep(1000);
  }

  const local = path.join(REPO, ".cr-track", "last-review.json");
  if (fs.existsSync(local)) {
    const r = JSON.parse(fs.readFileSync(local, "utf8"));
    console.log("\n── Sent");
    console.log("  review.id  : " + r.review.id);
    console.log("  commit     : " + r.review.commit.shortSha + " — " + r.review.commit.message.split("\n")[0]);
    console.log("  repository : " + r.repository.repo + " (" + r.repository.branch + ")");
    console.log("  findings   : " + r.findings.length);
    console.log("  annotations: " + ((r.annotations || []).length));
    for (const f of r.findings.slice(0, 5)) {
      console.log(`     ${f.severity.padEnd(10)} ${f.file}:${f.lineStart}  ${f.title}`);
    }
    for (const a of (r.annotations || []).slice(0, 3)) {
      console.log(`     ${String(a.severity).padEnd(10)} ${a.file}:${a.lineStart}  ${a.title}`);
    }
  }
  await ext.deactivate?.();
  restore();

  // The wait loop above ends on failure outcomes as well as success, and on
  // timeout it simply falls out. Exiting 0 regardless meant a rejected upload
  // read as a successful send to anything chaining on this — a CI step, or a
  // shell &&.
  const delivered = /Report sent to the dashboard/.test(state.logLines.join("\n"));
  if (!delivered) {
    console.error("\n  the report was not delivered — see the log above");
  }
  process.exit(delivered ? 0 : 1);
})().catch((err) => {
  // Mirrors live.js. Without this, a throw leaves a bare unhandled-rejection
  // trace, restore() never runs, and the vscode stub stays installed.
  console.error("\nsend-head crashed:\n", err);
  process.exit(2);
});
