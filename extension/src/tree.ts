/**
 * The Findings panel.
 *
 * A tree of folders → files → findings. The Problems panel is a good place for
 * squiggles but a bad one for reading a recommendation: it truncates, and it
 * interleaves CR-Track's findings with every other linter's. This view exists
 * so the developer can read through what the last commit turned up in one
 * place, with the full explanation on hover.
 */

import * as vscode from "vscode";
import type { Finding, Severity } from "@engine/types";

export type Node = FolderNode | FileNode | FindingNode;

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

  /** Set per review — one window can hold several repositories. */
  private repoRoot = "";

  constructor() {
    this.view = vscode.window.createTreeView("crTrack.findings", {
      treeDataProvider: this,
      showCollapseAll: true,
    });
    this.disposables.push(this.view, this.changed);
  }

  setFindings(findings: Finding[], repoRoot = this.repoRoot): void {
    this.repoRoot = repoRoot;
    this.findings = findings;
    this.root = buildTree(findings);
    this.changed.fire(undefined);
    this.view.badge = findings.length
      ? { value: findings.length, tooltip: `${findings.length} recommendation(s)` }
      : undefined;
    this.view.title = findings.length ? `Findings (${findings.length})` : "Findings";
  }

  clear(): void {
    this.setFindings([]);
  }

  /** Which repository the findings on screen belong to. */
  currentRepoRoot(): string {
    return this.repoRoot;
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
      item.description = `${node.findings.length}`;
      item.contextValue = "file";
      item.tooltip = node.path;
      return item;
    }

    return this.findingItem(node);
  }

  private findingItem(node: FindingNode): vscode.TreeItem {
    const f = node.finding;
    const item = new vscode.TreeItem(f.title, vscode.TreeItemCollapsibleState.None);
    const icon = SEVERITY_ICON[f.severity] ?? SEVERITY_ICON.nit;

    item.description = describe(f);
    item.tooltip = tooltipFor(f);
    item.iconPath = new vscode.ThemeIcon(icon.id, new vscode.ThemeColor(icon.color));
    item.contextValue = "finding";
    item.command = {
      command: "crTrack.revealFinding",
      title: "Go to finding",
      arguments: [node],
    };
    return item;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

function describe(f: Finding): string {
  const line = f.lineStart === f.lineEnd ? `${f.lineStart}` : `${f.lineStart}-${f.lineEnd}`;
  return `${f.severity} · line ${line}`;
}

function tooltipFor(f: Finding): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.supportThemeIcons = true;
  md.appendMarkdown(`**${escapeMd(f.title)}**\n\n`);
  md.appendMarkdown(
    `$(circle-filled) ${f.severity} · ${f.category} · ` +
      `${Math.round((f.confidence ?? 0) * 100)}% confidence\n\n`,
  );
  md.appendMarkdown(`${escapeMd(f.description)}\n\n`);
  md.appendMarkdown(`**Suggested**\n\n${escapeMd(f.suggestion)}\n`);
  if (f.fix) {
    md.appendMarkdown(`\n---\n\n`);
    md.appendCodeblock(f.fix.newText, "");
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

  const convert = (draft: Draft): Node[] => {
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
      out.push({ kind: "folder", label, path: cursor.path, children: convert(cursor) });
    }

    for (const [name, group] of [...draft.files].sort(([a], [b]) => a.localeCompare(b))) {
      out.push({ kind: "file", label: name, path: join(draft.path, name), findings: group });
    }

    return out;
  };

  return convert(root);
}

function join(a: string, b: string): string {
  return a ? `${a}/${b}` : b;
}
