/**
 * The Findings panel.
 *
 * A tree of folders → files → findings, with accept and reject on each row.
 * The Problems panel is a good place for squiggles but a bad place for a
 * decision: it has no notion of "I have dealt with this", and it interleaves
 * CR-Track's findings with every other linter's. This view exists so the
 * developer can work through a review in one place and see what they have
 * already decided.
 *
 * Resolved findings stay visible, marked. Rows that vanish the instant you
 * click them make it impossible to tell what you have done.
 */

import * as vscode from "vscode";
import type { Finding, Severity } from "@engine/types";
import type { FixProvider, Outcome } from "./fixes";

type Node = FolderNode | FileNode | FindingNode;

interface FolderNode {
  kind: "folder";
  /** Display label — may cover several path segments when chains are collapsed. */
  label: string;
  path: string;
  children: Node[];
}

interface FileNode {
  kind: "file";
  label: string;
  path: string;
  findings: Finding[];
}

interface FindingNode {
  kind: "finding";
  finding: Finding;
}

const SEVERITY_ICON: Record<Severity, { id: string; color: string }> = {
  blocking: { id: "error", color: "list.errorForeground" },
  important: { id: "warning", color: "list.warningForeground" },
  nit: { id: "info", color: "charts.blue" },
  suggestion: { id: "lightbulb", color: "charts.foreground" },
};

const SEVERITY_RANK: Record<Severity, number> = {
  blocking: 0,
  important: 1,
  nit: 2,
  suggestion: 3,
};

export class FindingsTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  private findings: Finding[] = [];
  private root: Node[] = [];
  private readonly view: vscode.TreeView<Node>;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly repoRoot: string,
    private readonly fixes: FixProvider,
  ) {
    this.view = vscode.window.createTreeView("crTrack.findings", {
      treeDataProvider: this,
      showCollapseAll: true,
    });
    this.disposables.push(this.view, this.changed);
    this.disposables.push(this.fixes.onDidChangeOutcomes(() => this.refresh()));
  }

  setFindings(findings: Finding[]): void {
    this.findings = findings;
    this.root = buildTree(findings);
    this.refresh();
  }

  clear(): void {
    this.setFindings([]);
  }

  refresh(): void {
    this.changed.fire(undefined);
    this.updateBadge();
  }

  /** Every finding that has not been accepted or rejected yet. */
  outstanding(): Finding[] {
    return this.findings.filter((f) => !this.fixes.outcomeFor(f.id));
  }

  private updateBadge(): void {
    const open = this.outstanding().length;
    const blocking = this.outstanding().filter((f) => f.severity === "blocking").length;
    this.view.badge = open ? { value: open, tooltip: `${open} open finding(s)` } : undefined;
    this.view.title = this.findings.length
      ? `Findings (${this.findings.length - open}/${this.findings.length} resolved)`
      : "Findings";
    void vscode.commands.executeCommand("setContext", "crTrack.hasBlocking", blocking > 0);
  }

  getChildren(node?: Node): Node[] {
    if (!node) return this.root;
    if (node.kind === "folder") return node.children;
    if (node.kind === "file") {
      return [...node.findings]
        .sort(
          (a, b) =>
            SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.lineStart - b.lineStart,
        )
        .map((finding) => ({ kind: "finding", finding }) satisfies FindingNode);
    }
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "folder") {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = vscode.ThemeIcon.Folder;
      item.contextValue = "folder";
      item.resourceUri = vscode.Uri.joinPath(vscode.Uri.file(this.repoRoot), node.path);
      return item;
    }

    if (node.kind === "file") {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.resourceUri = vscode.Uri.joinPath(vscode.Uri.file(this.repoRoot), node.path);
      item.iconPath = vscode.ThemeIcon.File;
      const open = node.findings.filter((f) => !this.fixes.outcomeFor(f.id)).length;
      item.description = open === node.findings.length
        ? `${node.findings.length}`
        : `${open} open · ${node.findings.length} total`;
      item.contextValue = open > 0 ? "file-open" : "file";
      item.tooltip = node.path;
      return item;
    }

    return this.findingItem(node.finding);
  }

  private findingItem(f: Finding): vscode.TreeItem {
    const outcome = this.fixes.outcomeFor(f.id);
    const item = new vscode.TreeItem(f.title, vscode.TreeItemCollapsibleState.None);

    item.description = describe(f, outcome?.outcome);
    item.tooltip = tooltipFor(f, outcome);

    if (outcome) {
      item.iconPath = new vscode.ThemeIcon(
        outcome.outcome === "applied" ? "check" : "circle-slash",
        new vscode.ThemeColor(
          outcome.outcome === "applied" ? "charts.green" : "disabledForeground",
        ),
      );
      // Nothing left to do with it, so no inline actions.
      item.contextValue = "finding-resolved";
    } else {
      const icon = SEVERITY_ICON[f.severity] ?? SEVERITY_ICON.nit;
      item.iconPath = new vscode.ThemeIcon(icon.id, new vscode.ThemeColor(icon.color));
      // Accept is only offered when there is actually a patch to apply.
      item.contextValue = f.fix ? "finding-fixable" : "finding";
    }

    item.command = {
      command: "crTrack.revealFinding",
      title: "Go to finding",
      arguments: [f],
    };
    return item;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

function describe(f: Finding, outcome?: Outcome): string {
  if (outcome === "applied") return "applied";
  if (outcome === "dismissed") return "dismissed";
  const confidence = Math.round((f.confidence ?? 0) * 100);
  const line = f.lineStart === f.lineEnd ? `${f.lineStart}` : `${f.lineStart}-${f.lineEnd}`;
  return `${f.id} · ${f.severity} · line ${line} · ${confidence}%`;
}

function tooltipFor(
  f: Finding,
  outcome?: { outcome: Outcome; reason?: string },
): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.supportThemeIcons = true;
  md.appendMarkdown(`**${escapeMd(f.title)}**\n\n`);
  md.appendMarkdown(
    `$(circle-filled) ${f.severity} · ${f.category} · ${Math.round((f.confidence ?? 0) * 100)}% confidence\n\n`,
  );
  md.appendMarkdown(`${escapeMd(f.description)}\n\n`);
  md.appendMarkdown(`**Suggested**\n\n${escapeMd(f.suggestion)}\n\n`);

  if (f.fix) {
    md.appendMarkdown(`---\n\n$(check) A patch is available — accept to apply it.\n\n`);
    md.appendCodeblock(f.fix.newText, "");
  } else {
    md.appendMarkdown(`---\n\n$(info) No automatic patch; this one needs a human.\n\n`);
  }

  if (outcome) {
    md.appendMarkdown(
      `\n\n**${outcome.outcome}**${outcome.reason ? ` — ${escapeMd(outcome.reason)}` : ""}`,
    );
  }
  return md;
}

function escapeMd(text: string): string {
  return text.replace(/[<>]/g, (c) => (c === "<" ? "&lt;" : "&gt;"));
}

/**
 * Group findings into a folder/file tree, collapsing single-child folder chains
 * so `src/api/routes/users.ts` does not cost four levels of indentation.
 */
export function buildTree(findings: Finding[]): Node[] {
  interface Draft {
    folders: Map<string, Draft>;
    files: Map<string, Finding[]>;
    path: string;
  }
  const root: Draft = { folders: new Map(), files: new Map(), path: "" };

  for (const f of findings) {
    const parts = f.file.split(/[\\/]/).filter(Boolean);
    const fileName = parts.pop();
    if (!fileName) continue;

    let node = root;
    for (const part of parts) {
      let next = node.folders.get(part);
      if (!next) {
        next = { folders: new Map(), files: new Map(), path: join(node.path, part) };
        node.folders.set(part, next);
      }
      node = next;
    }
    const list = node.files.get(fileName) ?? [];
    list.push(f);
    node.files.set(fileName, list);
  }

  const convert = (draft: Draft, labelSoFar: string): Node[] => {
    const out: Node[] = [];

    for (const [name, child] of [...draft.folders].sort(([a], [b]) => a.localeCompare(b))) {
      // Collapse a folder that contains exactly one folder and no files.
      let label = name;
      let cursor = child;
      while (cursor.folders.size === 1 && cursor.files.size === 0) {
        const [childName, only] = [...cursor.folders][0]!;
        label = `${label}/${childName}`;
        cursor = only;
      }
      out.push({
        kind: "folder",
        label,
        path: cursor.path,
        children: convert(cursor, label),
      });
    }

    for (const [name, group] of [...draft.files].sort(([a], [b]) => a.localeCompare(b))) {
      out.push({ kind: "file", label: name, path: join(draft.path, name), findings: group });
    }

    return out;
  };

  return convert(root, "");
}

function join(a: string, b: string): string {
  return a ? `${a}/${b}` : b;
}
