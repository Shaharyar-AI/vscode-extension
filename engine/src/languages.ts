/**
 * Extension → language, and language → which guide files to load.
 *
 * Guides live in the sibling `skill/references/` tree, so the ruleset the team
 * already maintains is the one the engine ships.
 */

import { extname } from "node:path";

const BY_EXT: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".mts": "TypeScript",
  ".cts": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".py": "Python",
  ".pyi": "Python",
  ".go": "Go",
  ".rs": "Rust",
  ".java": "Java",
  ".kt": "Kotlin",
  ".cs": "C#",
  ".rb": "Ruby",
  ".php": "PHP",
  ".swift": "Swift",
  ".c": "C",
  ".h": "C",
  ".cpp": "C++",
  ".cc": "C++",
  ".hpp": "C++",
  ".sh": "Shell",
  ".bash": "Shell",
  ".ps1": "PowerShell",
  ".sql": "SQL",
  ".css": "CSS",
  ".scss": "CSS",
  ".html": "HTML",
  ".vue": "Vue",
  ".svelte": "Svelte",
  ".json": "JSON",
  ".yaml": "YAML",
  ".yml": "YAML",
  ".md": "Markdown",
};

/** Guides that exist under skill/references/lang/. */
const GUIDE_BY_LANGUAGE: Record<string, string> = {
  TypeScript: "typescript",
  JavaScript: "javascript",
  Python: "python",
  Go: "go",
};

export function languageFor(path: string): string | null {
  return BY_EXT[extname(path).toLowerCase()] ?? null;
}

/** The dominant language across a change set, for reporting. */
export function primaryLanguage(paths: string[]): string | null {
  const counts = new Map<string, number>();
  for (const p of paths) {
    const lang = languageFor(p);
    if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [lang, n] of counts) {
    if (n > bestN) {
      best = lang;
      bestN = n;
    }
  }
  return best;
}

/**
 * Which `lang/*.md` guides to load for a change set. Files with no matching
 * guide simply fall back to the base ruleset — that is not an error.
 */
export function guidesFor(paths: string[]): string[] {
  const guides = new Set<string>();
  for (const p of paths) {
    const lang = languageFor(p);
    if (!lang) continue;
    const guide = GUIDE_BY_LANGUAGE[lang];
    if (guide) guides.add(guide);
  }
  return [...guides].sort();
}
