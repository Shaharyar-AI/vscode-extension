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

  /**
   * Findings the developer has marked done.
   *
   * Marked by hand rather than inferred. We cannot tell from an edit whether a
   * problem was actually solved, and a row that turned green on its own would
   * be worse than no signal at all — it would be a claim we cannot support.
   */
  private fixed = new Set<string>();

  /**
   * Of those, the ones the reviewer confirmed rather than the developer
   * asserted. Both are green; only the wording differs, because "I fixed this"
   * and "the reviewer agrees this is fixed" are not the same claim.
   */
  private verified = new Set<string>();

  /** Told when the fixed set changes, so it can be persisted and the squiggle dropped. */
  onFixedChanged: ((id: string, isFixed: boolean) => void) | undefined;

  constructor() {
    this.view = vscode.window.createTreeView("crTrack.findings", {
      treeDataProvider: this,
      showCollapseAll: true,
    });
    this.disposables.push(this.view, this.changed);
  }

  markFixed(id: string, isFixed = true): void {
    if (isFixed) this.fixed.add(id);
    else this.fixed.delete(id);
    this.onFixedChanged?.(id, isFixed);
    this.refresh();
  }

  isFixed(id: string): boolean {
    return this.fixed.has(id);
  }

  /** Restore marks recorded on a previous visit to the same review. */
  restoreFixed(ids: string[], verified: string[] = []): void {
    this.fixed = new Set(ids);
    this.verified = new Set(verified);
    this.refresh();
  }

  fixedIds(): string[] {
    return [...this.fixed];
  }

  allFindings(): Finding[] {
    return this.findings;
  }

  outstanding(): Finding[] {
    return this.findings.filter((f) => !this.fixed.has(f.id));
  }

  private refresh(): void {
    this.changed.fire(undefined);
    this.updateHeader();
  }

  private updateHeader(): void {
    const total = this.findings.length;
    const done = this.findings.filter((f) => this.fixed.has(f.id)).length;
    const left = total - done;

    if (!total) {
      this.view.badge = undefined;
      this.view.title = "Findings";
      return;
    }
    // The badge counts what is left to do, not what was found. A number that
    // never moves as you work is just decoration.
    this.view.badge = left
      ? { value: left, tooltip: `${left} still to address` }
      : { value: 0, tooltip: "All findings addressed" };
    this.view.title = done ? `Findings (${done}/${total} fixed)` : `Findings (${total})`;
  }

  setFindings(findings: Finding[], repoRoot = this.repoRoot): void {
    this.repoRoot = repoRoot;
    this.findings = findings;
    this.root = buildTree(findings);
    // A new review is a new set of problems; carrying marks across would show
    // last commit's progress against this commit's findings.
    this.fixed.clear();
    this.refresh();
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
      const done = node.findings.filter((f) => this.fixed.has(f.id)).length;
      item.description =
        done === 0
          ? `${node.findings.length}`
          : done === node.findings.length
            ? `all ${done} fixed`
            : `${done}/${node.findings.length} fixed`;
      item.contextValue = "file";
      item.tooltip = node.path;
      return item;
    }

    return this.findingItem(node);
  }

  private findingItem(node: FindingNode): vscode.TreeItem {
    const f = node.finding;
    const done = this.fixed.has(f.id);
    const item = new vscode.TreeItem(f.title, vscode.TreeItemCollapsibleState.None);

    if (done) {
      item.iconPath = new vscode.ThemeIcon("pass-filled", new vscode.ThemeColor("charts.green"));
      item.description = this.verified.has(f.id) ? "fixed · confirmed" : "fixed";
      // Distinct contextValue so the row offers "undo", not "mark fixed" again.
      item.contextValue = "finding-fixed";
    } else {
      const icon = SEVERITY_ICON[f.severity] ?? SEVERITY_ICON.nit;
      item.iconPath = new vscode.ThemeIcon(icon.id, new vscode.ThemeColor(icon.color));
      item.description = describe(f);
      item.contextValue = "finding-open";
    }

    item.tooltip = tooltipFor(f, done, this.verified.has(f.id));
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

function tooltipFor(f: Finding, done = false, verified = false): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.supportThemeIcons = true;
  if (done) {
    md.appendMarkdown(
      verified
        ? "$(pass-filled) **Fixed** — the reviewer re-read this file and did not raise it again."
        : "$(pass-filled) **Fixed** — marked by you.",
    );
    md.appendMarkdown("\n\n");
  }
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
