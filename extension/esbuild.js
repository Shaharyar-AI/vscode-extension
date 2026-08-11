// Bundles the extension (and the engine it imports) into a single CommonJS file.
// `vscode` is provided by the host at runtime and must stay external.
const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

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
