// Bundles the extension (and the engine it imports) into a single CommonJS file.
// `vscode` is provided by the host at runtime and must stay external.
const esbuild = require("esbuild");
const fs = require("node:fs");
const path = require("node:path");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/**
 * Copy the ruleset and language guides into the extension.
 *
 * A packaged .vsix has no monorepo around it, so without this the installed
 * extension reviews with no ruleset and no language guides — and does it
 * silently, because a missing guide tree is a legitimate state.
 */
function copyGuides() {
  const from = path.join(__dirname, "..", "skill", "references");
  const to = path.join(__dirname, "resources", "references");

  if (!fs.existsSync(path.join(from, "ruleset.md"))) {
    console.error(`✘ guides not found at ${from} — the packaged extension would ship without them`);
    process.exit(1);
  }

  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });

  const count = fs
    .readdirSync(to, { recursive: true })
    .filter((f) => String(f).endsWith(".md")).length;
  console.log(`[build] copied ${count} guide file(s)`);
}

/** Prints build results in a form VS Code's problem matcher can read. */
const reporter = {
  name: "reporter",
  setup(build) {
    build.onStart(() => console.log("[build] started"));
    build.onEnd((result) => {
      for (const e of result.errors) {
        console.error(`✘ ${e.text}`);
        if (e.location) console.error(`    ${e.location.file}:${e.location.line}:${e.location.column}`);
      }
      console.log(`[build] ${result.errors.length ? "failed" : "ok"}`);
    });
  },
};

async function main() {
  copyGuides();

  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node18",
    outfile: "dist/extension.js",
    external: ["vscode"],
    sourcemap: !production,
    minify: production,
    logLevel: "silent",
    plugins: [reporter],
  });

  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
