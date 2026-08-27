/**
 * End-to-end against the team's production tracker.
 *
 * Real repository, real commit, real Claude, real POST to ikonictracker with a
 * real ingest token. The token arrives in the environment and is never written
 * anywhere: this file must stay safe to commit.
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const cp = require("node:child_process");
const { makeStub, install, loadExtension, makeContext } = require("./stub");

const EXT_DIR = path.resolve(__dirname, "..");
const BUNDLE = path.join(EXT_DIR, "dist", "extension.js");
const ENDPOINT = process.env.CRT_U;
const TOKEN = process.env.CRT_T;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (repo, ...a) => cp.execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" });

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
  ok ? pass++ : fail++;
};

const BAD = `export async function transfer(from: string, to: string, amount) {
  const rate = await fetch("https://rates.example.com/" + from).then((r) => r.json());
  const sql = "UPDATE accounts SET balance = balance - " + amount + " WHERE id = '" + from + "'";
  await db.query(sql);
  return { ok: true, rate };
}
`;

(async () => {
  if (!ENDPOINT || !TOKEN) {
    console.error("Set CRT_U and CRT_T in the environment.");
    process.exit(2);
  }
  console.log("\nCR-Track — live against " + ENDPOINT + "\n");

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "crtrack-theirs-"));
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Shaharyar-AI");
  git(repo, "config", "user.email", "waleed@ikonicdev.com");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "remote", "add", "origin", "https://github.com/ikonic-git-admin/cr-track-pilot.git");
  fs.writeFileSync(path.join(repo, "README.md"), "# pilot\n");
  fs.writeFileSync(path.join(repo, ".cr-track.yaml"), `endpoint: ${ENDPOINT}\n`);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  try { git(repo, "branch", "-M", "main"); } catch { /* already main */ }

  console.log("── Booting the extension");
  const { vscode, state } = makeStub({ repo });
  // Nobody is present to answer the send prompt in an automated run, and an
// unanswered prompt holds the report — which is the correct behaviour and the
// wrong thing to test here.
state.config.set("crTrack.confirmBeforeSending", false);
const restore = install(vscode);
  const ext = loadExtension(BUNDLE);
  const context = makeContext(EXT_DIR);
  await ext.activate(context);
  await sleep(1500);
  check("The extension is active",
    typeof state.statusText === "string" &&
      state.statusText.length > 0 &&
      !/ · /.test(state.statusText),
    state.statusText || "(status bar never written)",
    "the status bar is empty, which this check used to read as active");

  // Store the token the way a developer would, through the real command.
  await context.secrets.store("crTrack.ingestToken", TOKEN);
  check("A token is in secret storage",
    typeof (await context.secrets.get("crTrack.ingestToken")) === "string", "stored");

  console.log("\n── Committing something worth reviewing");
  fs.writeFileSync(path.join(repo, "src", "payments.ts"), BAD, "utf8");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "Add the transfer endpoint");
  const sha = git(repo, "rev-parse", "HEAD").trim();
  console.log("  " + sha.slice(0, 7));

  for (const w of state.fileWatchers) {
    if (/logs\/HEAD|^HEAD$/.test(w.pattern)) w.fireChange({ fsPath: "logs/HEAD" });
  }

  console.log("\n── Waiting for the review and the upload");
  const DONE = /Report sent to the dashboard|Dashboard unreachable|rejected the report|Reporting failed|Review failed/;
  const deadline = Date.now() + 420_000;
  let last = "";
  while (Date.now() < deadline) {
    const line = state.logLines[state.logLines.length - 1] || "";
    if (line !== last) { last = line; console.log("  " + line); }
    if (DONE.test(state.logLines.join("\n"))) break;
    await sleep(1000);
  }
  const log = state.logLines.join("\n");

  check("The commit was reviewed", /finding\(s\) in \d+s/.test(log), sha.slice(0, 7));
  check("The report was accepted, not rejected",
    /Report sent to the dashboard \(200\)/.test(log),
    (log.match(/Report sent to the dashboard \([^)]*\)|rejected the report[^\n]*|Dashboard unreachable[^\n]*/) || ["(nothing)"])[0]);
  check("...and nothing was queued for retry",
    !fs.existsSync(path.join(repo, ".cr-track", "queue")) ||
      fs.readdirSync(path.join(repo, ".cr-track", "queue")).length === 0,
    "queue empty");

  // The checks above are written to fail gracefully when a review times out or
  // delivery is refused. Reading this unconditionally would then throw, so the
  // payload checks below would never run and the summary would never print —
  // a failed review would look like a crashed harness.
  const localPath = path.join(repo, ".cr-track", "last-review.json");
  if (!fs.existsSync(localPath)) {
    check("A report was written locally", false, "",
      "no .cr-track/last-review.json — the review never got far enough to write one");
    await ext.deactivate?.();
    restore();
    console.log(`\nResult  ${pass} passed  ${fail} failed\n`);
    process.exit(1);
  }
  const local = JSON.parse(fs.readFileSync(localPath, "utf8"));
  console.log("\n── What they received");
  console.log("  review.id  : " + local.review.id);
  console.log("  repository : " + local.repository.repo + " (" + local.repository.branch + ")");
  console.log("  developer  : " + local.developer.name + " <" + local.developer.email + ">");
  console.log("  findings   : " + local.findings.length);
  for (const f of local.findings.slice(0, 4)) {
    // Defaulted so a malformed payload is reported by the check below, rather
    // than throwing here before that check ever runs.
    console.log(
      `     ${String(f.severity ?? "?").padEnd(10)} ${f.file}:${f.lineStart}  ${f.title}`,
    );
  }
  check("The payload is schema 2.x", /^2\./.test(local.schemaVersion), local.schemaVersion);
  check("...with findings carrying severity, status and accepted",
    local.findings.every((f) => f.severity && f.status && typeof f.accepted === "boolean"),
    "all three present on every finding");
  check("...and repository.repo qualified by owner",
    String(local.repository.repo).includes("/"), local.repository.repo);

  await ext.deactivate?.();
  restore();
  console.log(`\nResult  ${pass} passed  ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  // Without this a throw anywhere above surfaces as a bare unhandled rejection:
  // the summary never prints and the vscode stub stays installed in the
  // process. This test drives a real commit and a real POST, so a mid-run
  // failure is an ordinary outcome rather than a rare one.
  console.error("\nlive-theirs crashed:\n", err);
  process.exit(2);
});
