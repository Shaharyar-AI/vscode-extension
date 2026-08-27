/**
 * Does fixing a problem actually turn it green?
 *
 * Real repository, real commits, real Claude. Two genuine bugs go in; one is
 * fixed and the other deliberately left alone. The point of the test is the
 * pair: green must follow the fix, and must not follow the one still broken.
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const cp = require("node:child_process");
const { makeStub, install, loadExtension, makeContext } = require("./stub");

const EXT_DIR = path.resolve(__dirname, "..");
const BUNDLE = path.join(EXT_DIR, "dist", "extension.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (repo, ...a) => cp.execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" });

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
  ok ? pass++ : fail++;
};

const BROKEN = `export function totalCents(items: { cents: number }[]) {
  let total = 0;
  for (let i = 0; i <= items.length; i++) {
    total += items[i].cents;
  }
  return total;
}

export function discount(price: number, percent: number) {
  return price - price * percent;
}
`;

const ONE_FIXED = `export function totalCents(items: { cents: number }[]) {
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    total += items[i].cents;
  }
  return total;
}

export function discount(price: number, percent: number) {
  return price - price * percent;
}
`;

async function waitForReview(state, from, mins = 6) {
  const DONE = /Report sent to the dashboard|Dashboard unreachable|Report written locally|Reporting failed|Review failed/;
  const deadline = Date.now() + mins * 60_000;
  while (Date.now() < deadline) {
    const since = state.logLines.slice(from).join("\n");
    if (DONE.test(since)) return since;
    await sleep(1500);
  }
  return state.logLines.slice(from).join("\n");
}

const rows = (state) => {
  const p = state.treeView.provider;
  const out = [];
  const walk = (node) => {
    for (const child of p.getChildren(node)) {
      const item = p.getTreeItem(child);
      if (child.kind === "finding") {
        out.push({ id: child.finding.id, title: child.finding.title,
                   ctx: item.contextValue, desc: item.description });
      } else walk(child);
    }
  };
  walk(undefined);
  return out;
};

(async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cr-green-"));
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Green Demo");
  git(repo, "config", "user.email", "demo@ikonicdev.com");
  git(repo, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(repo, "README.md"), "# demo\n");
  fs.writeFileSync(path.join(repo, ".cr-track.yaml"), "endpoint: \"\"\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");

  const { vscode, state } = makeStub({ repo });
  // Nobody is present to answer the send prompt in an automated run, and an
// unanswered prompt holds the report — which is the correct behaviour and the
// wrong thing to test here.
state.config.set("crTrack.confirmBeforeSending", false);
const restore = install(vscode);
  const ext = loadExtension(BUNDLE);
  await ext.activate(makeContext(EXT_DIR));
  await sleep(1500);

  // ── commit 1: two real bugs ───────────────────────────────────────────
  console.log("\n── Commit 1: an off-by-one and a wrong discount formula");
  fs.writeFileSync(path.join(repo, "src", "money.ts"), BROKEN, "utf8");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "Add money helpers");
  let mark = state.logLines.length;
  for (const w of state.fileWatchers) if (/logs\/HEAD|^HEAD$/.test(w.pattern)) w.fireChange({});
  await waitForReview(state, mark);

  const first = rows(state);
  console.log(`  reviewer reported ${first.length} finding(s):`);
  for (const r of first) console.log(`    [${r.id}] ${r.title}`);
  check("The first commit produced findings", first.length >= 1, `${first.length}`);
  check("...and none of them start green",
    first.every((r) => r.ctx === "finding-open"), "all open");

  // ── commit 2: fix the loop bound, leave the discount alone ────────────
  console.log("\n── Commit 2: fixing ONLY the loop bound");
  fs.writeFileSync(path.join(repo, "src", "money.ts"), ONE_FIXED, "utf8");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "Fix the off-by-one in totalCents");
  mark = state.logLines.length;
  for (const w of state.fileWatchers) if (/logs\/HEAD|^HEAD$/.test(w.pattern)) w.fireChange({});
  const log2 = await waitForReview(state, mark);

  const after = rows(state);
  const green = after.filter((r) => r.ctx === "finding-fixed");
  const open = after.filter((r) => r.ctx === "finding-open");

  console.log(`\n  panel now shows ${after.length} row(s):`);
  for (const r of after) {
    console.log(`    ${r.ctx === "finding-fixed" ? "GREEN" : "open "}  ${r.title}  (${r.desc})`);
  }
  console.log("\n  title: " + state.treeView.title);
  console.log("  badge: " + JSON.stringify(state.treeView.badge));

  check("Something turned green after the fix", green.length >= 1, `${green.length} green`);
  check("...labelled as confirmed, not merely asserted",
    green.every((r) => String(r.desc).includes("confirmed")),
    green.map((r) => r.desc).join(", "));
  check("...and it is the off-by-one that went green",
    green.some((r) => /off-by-one|loop|bound|index|<=|out of|range/i.test(r.title)),
    green.map((r) => r.title).join(" | "));
  check("Something is still open — the bug nobody fixed",
    open.length >= 1, `${open.length} open`);
  check("The title counts the progress",
    /\d+\/\d+ fixed/.test(state.treeView.title || ""), state.treeView.title);
  check("The badge counts what is left, not what was found",
    state.treeView.badge?.value === open.length, `badge ${state.treeView.badge?.value}`);
  check("The log says the fix was confirmed on re-read",
    /confirmed on re-read/.test(log2), "logged");

  restore();
  console.log(`\nResult  ${pass} passed  ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
