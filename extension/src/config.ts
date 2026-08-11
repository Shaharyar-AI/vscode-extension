/**
 * Configuration, resolved from two places.
 *
 * `.cr-track.yaml` at the repo root is the team's shared answer and wins for
 * review behaviour, so everyone on a repo gets the same review. VS Code
 * settings cover machine-local concerns (where the CLI lives, whether the
 * extension is on at all) and fill in anything the file does not state.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { CATEGORIES, DEFAULT_CONFIG, type Category, type EngineConfig } from "@engine/types";

export interface Settings extends EngineConfig {
  enabled: boolean;
  claudePath: string | undefined;
  debounceMs: number;
  blockCommitOnBlocking: boolean;
}

/**
 * A deliberately small YAML reader.
 *
 * `.cr-track.yaml` is a flat file of scalars and inline lists, and pulling in a
 * full YAML parser to read six keys would be the only runtime dependency in the
 * extension. Anything it cannot understand is ignored rather than guessed at.
 */
export function parseSimpleYaml(text: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trimEnd();
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (/^\s/.test(raw)) continue; // nested block — out of scope

    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    let value = line.slice(sep + 1).trim();
    if (!key || !value) continue;

    if (value.startsWith("[") && value.endsWith("]")) {
      out[key] = value
        .slice(1, -1)
        .split(",")
        .map((v) => v.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else {
      out[key] = value.replace(/^["']|["']$/g, "");
    }
  }
  return out;
}

/** Legacy severity names from before the 2.0 model. */
const LEGACY_SEVERITY: Record<string, EngineConfig["minSeverity"]> = {
  info: "nit",
  warning: "important",
  critical: "blocking",
};

export function readSettings(repoRoot: string | undefined): Settings {
  const vs = vscode.workspace.getConfiguration("crTrack");

  const settings: Settings = {
    ...DEFAULT_CONFIG,
    enabled: vs.get<boolean>("enabled", true),
    claudePath: vs.get<string>("claudePath")?.trim() || undefined,
    debounceMs: vs.get<number>("debounceMs", 2000),
    blockCommitOnBlocking: vs.get<boolean>("blockCommitOnBlocking", true),
    model: vs.get<string>("model", DEFAULT_CONFIG.model),
    effort: vs.get<EngineConfig["effort"]>("effort", DEFAULT_CONFIG.effort),
    profile: vs.get<EngineConfig["profile"]>("profile", DEFAULT_CONFIG.profile),
    minSeverity: vs.get<EngineConfig["minSeverity"]>("minSeverity", DEFAULT_CONFIG.minSeverity),
    timeoutMs: vs.get<number>("timeoutSeconds", 300) * 1000,
  };

  if (!repoRoot) return settings;
  const path = join(repoRoot, ".cr-track.yaml");
  if (!existsSync(path)) return settings;

  let yaml: Record<string, string | string[]>;
  try {
    yaml = parseSimpleYaml(readFileSync(path, "utf8"));
  } catch {
    return settings; // unreadable config is not worth failing a review over
  }

  const profile = yaml["profile"];
  if (typeof profile === "string" && ["chill", "balanced", "assertive"].includes(profile)) {
    settings.profile = profile as EngineConfig["profile"];
  }

  const min = yaml["min_severity_to_report"];
  if (typeof min === "string") {
    const mapped = LEGACY_SEVERITY[min] ?? (min as EngineConfig["minSeverity"]);
    if (["blocking", "important", "nit", "suggestion"].includes(mapped)) {
      settings.minSeverity = mapped;
    }
  }

  const cats = yaml["categories_enabled"];
  if (Array.isArray(cats)) {
    const valid = cats.filter((c): c is Category => (CATEGORIES as string[]).includes(c));
    if (valid.length) settings.categoriesEnabled = valid;
  }

  const model = yaml["model"];
  if (typeof model === "string") settings.model = model;

  const effort = yaml["effort"];
  if (typeof effort === "string" && ["low", "medium", "high", "xhigh", "max"].includes(effort)) {
    settings.effort = effort as EngineConfig["effort"];
  }

  return settings;
}

/** Where reports get POSTed, if the repo asks for it. */
export function readEndpoint(repoRoot: string | undefined): string | undefined {
  if (!repoRoot) return undefined;
  const path = join(repoRoot, ".cr-track.yaml");
  if (!existsSync(path)) return undefined;
  try {
    const yaml = parseSimpleYaml(readFileSync(path, "utf8"));
    const endpoint = yaml["endpoint"];
    return typeof endpoint === "string" && endpoint.startsWith("http") ? endpoint : undefined;
  } catch {
    return undefined;
  }
}
