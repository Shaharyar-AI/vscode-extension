/**
 * A scriptable `vscode` stub.
 *
 * Rich enough that the extension cannot tell the difference for anything that
 * is not actual pixels: documents are read from and written to disk, commands
 * route to their real handlers, and dialogs answer from a queue the test sets
 * up in advance.
 *
 * What it cannot prove: that anything renders. Icons, squiggle painting, menu
 * placement and hover formatting all need a real window.
 */

const fs = require("node:fs");
const path = require("node:path");

function makeStub({ repo, answers = {}, onLog }) {
  const disposable = () => ({ dispose() {} });
  const noopEvent = () => disposable();

  const state = {
    statusText: "",
    statusTooltip: "",
    statusColor: undefined,
    diagnostics: new Map(),
    commands: new Map(),
    messages: [],
    inputs: [],
    treeView: undefined,
    contexts: new Map(),
    fileWatchers: [],
    windowStateHandlers: [],
    logLines: [],
    clipboard: "",
  };

  // Dialog answers are consumed in order; a missing script entry means
  // "user dismissed", which is the safest default for a test.
  const queues = {
    warning: [...(answers.warning ?? [])],
    info: [...(answers.info ?? [])],
    input: [...(answers.input ?? [])],
  };

  class EventEmitter {
    constructor() { this.handlers = []; }
    get event() { return (h) => { this.handlers.push(h); return disposable(); }; }
    fire(v) { for (const h of this.handlers) h(v); }
    dispose() { this.handlers = []; }
  }

  class Uri {
    constructor(fsPath) { this.fsPath = fsPath; this.scheme = "file"; }
    static file(p) { return new Uri(p); }
    static parse(s) { return new Uri(decodeURI(s).replace(/^file:\/\//, "")); }
    static joinPath(base, ...parts) { return new Uri(path.join(base.fsPath, ...parts)); }
    toString() { return `file://${this.fsPath.replace(/\\/g, "/")}`; }
  }

  class Position { constructor(line, character) { this.line = line; this.character = character; } }
  class Range {
    constructor(a, b, c, d) {
      this.start = a instanceof Position ? a : new Position(a, b);
      this.end = c instanceof Position ? c : new Position(c, d);
    }
  }
  class Selection extends Range {}

  /** A document backed by the real file, with the line API the extension uses. */
  function openDoc(uri) {
    const text = fs.existsSync(uri.fsPath) ? fs.readFileSync(uri.fsPath, "utf8") : "";
    const lines = text.split("\n");
    return {
      uri,
      lineCount: lines.length,
      getText(range) {
        if (!range) return text;
        const slice = lines.slice(range.start.line, range.end.line + 1);
        if (slice.length === 0) return "";
        const lastIdx = slice.length - 1;
        slice[lastIdx] = slice[lastIdx].slice(0, range.end.character);
        slice[0] = slice[0].slice(range.start.character);
        return slice.join("\n");
      },
      lineAt(n) { return { text: lines[n] ?? "", lineNumber: n }; },
      save: async () => true,
    };
  }

  class WorkspaceEdit {
    constructor() { this.entries = []; }
    replace(uri, range, newText) { this.entries.push({ uri, range, newText }); }
  }

  const vscode = {
    Uri, EventEmitter, Range, Position, Selection, WorkspaceEdit,
    Disposable: Object.assign(
      class { constructor(fn) { this.dispose = fn ?? (() => {}); } },
      { from: (...ds) => ({ dispose: () => ds.forEach((d) => d?.dispose?.()) }) },
    ),
    CodeAction: class { constructor(title, kind) { this.title = title; this.kind = kind; } },
    CodeActionKind: { QuickFix: { value: "quickfix" } },
    TreeItem: class { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: Object.assign(
      class { constructor(id, color) { this.id = id; this.color = color; } },
      { Folder: { id: "folder" }, File: { id: "file" } },
    ),
    ThemeColor: class { constructor(id) { this.id = id; } },
    MarkdownString: class {
      constructor() { this.value = ""; this.supportThemeIcons = false; }
      appendMarkdown(s) { this.value += s; return this; }
      appendCodeblock(s) { this.value += "\n```\n" + s + "\n```\n"; return this; }
    },
    Diagnostic: class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
    TextEditorRevealType: { InCenter: 2 },
    RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
    env: { clipboard: { writeText: async (t) => { state.clipboard = String(t); } } },

    window: {
      createOutputChannel: () => ({
        name: "CR-Track",
        appendLine: (l) => { state.logLines.push(l); onLog?.(l); },
        show() {}, dispose() {},
      }),
      createStatusBarItem: () => ({
        show() {}, hide() {}, dispose() {},
        set text(v) { state.statusText = v; }, get text() { return state.statusText; },
        set tooltip(v) { state.statusTooltip = v; }, get tooltip() { return state.statusTooltip; },
        set backgroundColor(v) { state.statusColor = v; }, get backgroundColor() { return state.statusColor; },
        command: undefined, name: undefined,
      }),
      showWarningMessage: async (message, ...rest) => {
        state.messages.push({ kind: "warning", message });
        return queues.warning.shift();
      },
      showInformationMessage: async (message) => {
        state.messages.push({ kind: "info", message });
        return queues.info.shift();
      },
      showErrorMessage: async (message) => {
        state.messages.push({ kind: "error", message });
        return undefined;
      },
      showInputBox: async (opts) => {
        state.inputs.push(opts?.title ?? opts?.prompt ?? "");
        return queues.input.shift();
      },
      showTextDocument: async () => ({ revealRange() {}, set selection(_v) {} }),
      withProgress: async (_o, task) => {
        // A real CancellationToken shape. The previous placeholder lacked
        // onCancellationRequested, so any code registering for cancellation
        // threw — and the harness reported it as "no findings".
        const token = {
          isCancellationRequested: false,
          onCancellationRequested: () => ({ dispose() {} }),
        };
        return task({ report() {} }, token);
      },
      onDidChangeWindowState: (h) => { state.windowStateHandlers.push(h); return disposable(); },
      setStatusBarMessage: () => ({ dispose() {} }),
      createTreeView: (id, opts) => {
        const view = { id, provider: opts.treeDataProvider, badge: undefined, title: undefined, dispose() {} };
        state.treeView = view;
        return view;
      },
    },

    workspace: {
      workspaceFolders: repo ? [{ uri: Uri.file(repo), name: path.basename(repo), index: 0 }] : undefined,
      getConfiguration: () => ({ get: (_k, d) => d }),
      // Records its handlers so a test can fire disk events by hand — the
      // recovery path is otherwise untestable without a real file watcher.
      createFileSystemWatcher: (pattern) => {
        const changed = [], created = [], deleted = [];
        const w = {
          pattern: pattern?.pattern ?? String(pattern),
          onDidChange(h) { changed.push(h); return disposable(); },
          onDidCreate(h) { created.push(h); return disposable(); },
          onDidDelete(h) { deleted.push(h); return disposable(); },
          fireChange(uri) { changed.forEach((h) => h(uri)); },
          fireCreate(uri) { created.forEach((h) => h(uri)); },
          disposed: false,
          dispose() { this.disposed = true; },
        };
        state.fileWatchers.push(w);
        return w;
      },
      onDidChangeConfiguration: noopEvent,
      onDidChangeWorkspaceFolders: noopEvent,
      openTextDocument: async (uri) => openDoc(uri instanceof Uri ? uri : Uri.file(String(uri))),
      applyEdit: async (edit) => {
        // Write through to disk so assertions can read the real result.
        for (const { uri, range, newText } of edit.entries) {
          const lines = fs.readFileSync(uri.fsPath, "utf8").split("\n");
          const before = lines.slice(0, range.start.line);
          const after = lines.slice(range.end.line + 1);
          fs.writeFileSync(uri.fsPath, [...before, ...newText.split("\n"), ...after].join("\n"), "utf8");
        }
        return true;
      },
    },

    commands: {
      registerCommand: (id, fn) => { state.commands.set(id, fn); return disposable(); },
      executeCommand: async (id, ...args) => {
        if (id === "setContext") { state.contexts.set(args[0], args[1]); return; }
        const handler = state.commands.get(id);
        if (handler) return handler(...args);
        state.messages.push({ kind: "host-command", message: id });
        return undefined;
      },
    },

    languages: {
      registerCodeActionsProvider: (_s, provider) => { state.codeActions = provider; return disposable(); },
      createDiagnosticCollection: () => ({
        clear: () => state.diagnostics.clear(),
        set: (uri, diags) => state.diagnostics.set(uri.toString(), diags),
        delete: (uri) => state.diagnostics.delete(uri.toString()),
        dispose() {},
      }),
    },
  };

  return { vscode, state };
}

/** Install the stub for `require("vscode")` and give back a reset function. */
function install(vscode) {
  const Module = require("node:module");
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "vscode") return vscode;
    return original.call(this, request, parent, isMain);
  };
  return () => { Module._load = original; };
}

/** Load a fresh copy of the extension bundle. */
function loadExtension(bundlePath) {
  delete require.cache[require.resolve(bundlePath)];
  return require(bundlePath);
}

function makeContext(extensionDir, store = new Map()) {
  return {
    subscriptions: [],
    extensionPath: extensionDir,
    extensionUri: { fsPath: extensionDir },
    extension: { packageJSON: { version: "0.1.0" } },
    globalState: { get: (k) => store.get(k), update: async (k, v) => void store.set(k, v) },
    workspaceState: { get: (k) => store.get(k), update: async (k, v) => void store.set(k, v) },
    // Exposed so a test can reopen a "new window" against the same stored
    // state, which is the only way to prove anything survives a reload.
    store,
  };
}

module.exports = { makeStub, install, loadExtension, makeContext };
