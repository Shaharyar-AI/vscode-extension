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

class Range { constructor(a, b, c, d) { Object.assign(this, { a, b, c, d }); this.start = { line: a }; this.end = { line: c }; } }

const vscode = {
  Uri,
  EventEmitter,
  Range,
  Selection: class extends Range {},
  Position: class { constructor(line, character) { Object.assign(this, { line, character }); } },
  WorkspaceEdit: class { constructor() { this.edits = []; } replace(uri, range, text) { this.edits.push({ uri, range, text }); } },
  CodeAction: class { constructor(title, kind) { Object.assign(this, { title, kind }); } },
  CodeActionKind: { QuickFix: { value: "quickfix" }, Refactor: { value: "refactor" } },
  TextEditorRevealType: { InCenter: 2 },
  TreeItem: class { constructor(label, collapsibleState) { Object.assign(this, { label, collapsibleState }); } },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  MarkdownString: class {
    constructor() { this.value = ""; }
    appendMarkdown(s) { this.value += s; return this; }
    appendCodeblock(s) { this.value += "\n```\n" + s + "\n```\n"; return this; }
  },
  ThemeIcon: Object.assign(
    class { constructor(id, color) { Object.assign(this, { id, color }); } },
    { Folder: { id: "folder" }, File: { id: "file" } },
  ),
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
    showInputBox: async () => undefined,
    showTextDocument: async () => ({ revealRange() {}, set selection(_v) {} }),
    withProgress: async (_o, task) => task({ report() {} }, { isCancellationRequested: false }),
    createTreeView: (id, opts) => {
      const view = {
        id,
        provider: opts.treeDataProvider,
        badge: undefined,
        title: undefined,
        reveal: async () => {},
        dispose() {},
      };
      state.treeView = view;
      return view;
    },
  },
  workspace: {
    workspaceFolders: [{ uri: Uri.file(repo), name: path.basename(repo), index: 0 }],
    getConfiguration: () => ({ get: (_k, d) => d }),
    createFileSystemWatcher: () => ({ onDidChange: noopEvent, onDidCreate: noopEvent, onDidDelete: noopEvent, dispose() {} }),
    onDidChangeConfiguration: noopEvent,
    onDidChangeWorkspaceFolders: noopEvent,
    openTextDocument: async () => ({ lineCount: 1, getText: () => "", lineAt: () => ({ text: "" }) }),
    applyEdit: async () => true,
  },
  commands: {
    registerCommand: (id, fn) => { state.commands.set(id, fn); return disposable(); },
    executeCommand: async () => undefined,
  },
  languages: {
    registerCodeActionsProvider: () => ({ dispose() {} }),
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

  // Walk the Findings tree exactly as VS Code would render it.
  const p = state.treeView?.provider;
  if (p) {
    say(`smoke: tree title = "${state.treeView.title}", badge = ${JSON.stringify(state.treeView.badge)}`);
    say("smoke: Findings panel —");
    const walk = async (node, depth) => {
      for (const child of (await p.getChildren(node)) ?? []) {
        const item = await p.getTreeItem(child);
        const inline = child.kind === "finding"
          ? `   [${item.contextValue === "finding-fixable" ? "accept|reject" : "reject"}]`
          : "";
        say(`${"  ".repeat(depth + 1)}${item.label}${item.description ? `   ${item.description}` : ""}${inline}`);
        await walk(child, depth + 1);
      }
    };
    await walk(undefined, 0);
  } else {
    say("smoke: FAIL — no tree view was created");
  }

  ext.deactivate();
  say("smoke: deactivate() ok");

  const failed = /circle-slash/.test(state.statusText);
  say(failed ? "\nSMOKE FAILED — review errored" : "\nSMOKE PASSED");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("smoke: threw —", e); process.exit(1); });
