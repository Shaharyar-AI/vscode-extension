/**
 * Activation smoke test.
 *
 * Loads the built bundle with a stubbed `vscode` module and activates it
 * against a real repository. Not a substitute for running in the editor, but it
 * catches the things that break first: import errors, top-level throws, bad
 * activation wiring, and the review loop never firing.
 *
 *   node smoke.js <repo-path> [--wait 120]
 */

const Module = require("node:module");
const path = require("node:path");

const repo = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
const waitIdx = process.argv.indexOf("--wait");
const waitSec = waitIdx > -1 ? Number(process.argv[waitIdx + 1]) : 120;

const out = [];
const say = (...a) => { const s = a.join(" "); out.push(s); console.log(s); };

// ── vscode stub ──────────────────────────────────────────────────────────
const disposable = () => ({ dispose() {} });
const noopEvent = () => disposable();

class EventEmitter {
  constructor() { this.handlers = []; }
  get event() { return (h) => { this.handlers.push(h); return disposable(); }; }
  fire(v) { for (const h of this.handlers) h(v); }
  dispose() { this.handlers = []; }
}

class Uri {
  constructor(fsPath) { this.fsPath = fsPath; this.scheme = "file"; }
  static file(p) { return new Uri(p); }
  static parse(s) { return new Uri(s.replace(/^file:\/\//, "")); }
  static joinPath(base, ...parts) { return new Uri(path.join(base.fsPath, ...parts)); }
  toString() { return `file://${this.fsPath.replace(/\\/g, "/")}`; }
}

const state = { statusText: "", statusTooltip: "", diagnostics: new Map(), commands: new Map(), warnings: [] };

const vscode = {
  Uri,
  EventEmitter,
  Range: class { constructor(a, b, c, d) { Object.assign(this, { a, b, c, d }); } },
  Diagnostic: class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ThemeColor: class { constructor(id) { this.id = id; } },
  ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
  RelativePattern: class { constructor(base, pattern) { Object.assign(this, { base, pattern }); } },
  env: { clipboard: { writeText: async () => {} } },
  window: {
    createOutputChannel: (name) => ({
      name,
      appendLine: (l) => console.log(`      | ${l}`),
      show() {}, dispose() {},
    }),
    createStatusBarItem: () => ({
      show() {}, hide() {}, dispose() {},
      set text(v) { state.statusText = v; },   get text() { return state.statusText; },
      set tooltip(v) { state.statusTooltip = v; }, get tooltip() { return state.statusTooltip; },
      backgroundColor: undefined, command: undefined, name: undefined,
    }),
    showWarningMessage: async (m) => { state.warnings.push(m); say(`  [warn] ${m}`); return undefined; },
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    withProgress: async (_o, task) => task({ report() {} }, { isCancellationRequested: false }),
  },
  workspace: {
    workspaceFolders: [{ uri: Uri.file(repo), name: path.basename(repo), index: 0 }],
    getConfiguration: () => ({ get: (_k, d) => d }),
    createFileSystemWatcher: () => ({ onDidChange: noopEvent, onDidCreate: noopEvent, onDidDelete: noopEvent, dispose() {} }),
    onDidChangeConfiguration: noopEvent,
    onDidChangeWorkspaceFolders: noopEvent,
  },
  commands: {
    registerCommand: (id, fn) => { state.commands.set(id, fn); return disposable(); },
    executeCommand: async () => undefined,
  },
  languages: {
    createDiagnosticCollection: () => ({
      clear: () => state.diagnostics.clear(),
      set: (uri, diags) => state.diagnostics.set(uri.toString(), diags),
      dispose() {},
    }),
  },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") return vscode;
  return origLoad.call(this, request, parent, isMain);
};

// ── run ──────────────────────────────────────────────────────────────────
(async () => {
  say(`smoke: repo = ${repo}`);
  const ext = require("./dist/extension.js");

  if (typeof ext.activate !== "function") { say("FAIL: no activate export"); process.exit(1); }
  if (typeof ext.deactivate !== "function") { say("FAIL: no deactivate export"); process.exit(1); }

  const store = new Map();
  const context = {
    subscriptions: [],
    globalState: { get: (k) => store.get(k), update: async (k, v) => void store.set(k, v) },
    workspaceState: { get: (k) => store.get(k), update: async (k, v) => void store.set(k, v) },
    extensionPath: __dirname,
  };

  const t0 = Date.now();
  await ext.activate(context);
  say(`smoke: activate() returned in ${Date.now() - t0}ms`);
  say(`smoke: ${context.subscriptions.length} disposables, ${state.commands.size} commands registered`);
  say(`smoke: commands = ${[...state.commands.keys()].join(", ")}`);
  say(`smoke: status = "${state.statusText}" (${state.statusTooltip})`);

  // The initial review is fired without await, so poll for it to land.
  const deadline = Date.now() + waitSec * 1000;
  let last = "";
  while (Date.now() < deadline) {
    if (state.statusText !== last) { last = state.statusText; say(`smoke: status -> "${last}"`); }
    if (!/Reviewing/.test(state.statusText) && state.diagnostics.size > 0) break;
    if (/circle-slash/.test(state.statusText)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  const total = [...state.diagnostics.values()].reduce((n, d) => n + d.length, 0);
  say(`smoke: ${total} diagnostic(s) across ${state.diagnostics.size} file(s)`);
  for (const [uri, diags] of state.diagnostics) {
    say(`  ${path.basename(uri)}`);
    for (const d of diags) say(`    [${d.code}] ${String(d.message).split("\n")[0]}`);
  }

  ext.deactivate();
  say("smoke: deactivate() ok");

  const failed = /circle-slash/.test(state.statusText);
  say(failed ? "\nSMOKE FAILED — review errored" : "\nSMOKE PASSED");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("smoke: threw —", e); process.exit(1); });
