/**
 * The output contract.
 *
 * This is handed to the CLI as `--json-schema`, so the model either returns
 * something matching it or fails loudly. That removes the whole
 * parse-then-retry-then-repair loop the prototype prompt carried.
 *
 * Deliberately absent: id, status, accepted, dismissReason, and every scrap of
 * envelope metadata. The engine owns all of that.
 */

import { CATEGORIES, SEVERITY_ORDER } from "./types";

export const FINDINGS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      description:
        "Issues worth fixing. Empty when the change set is clean — an empty array is a valid, expected answer.",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "file",
          "lineStart",
          "lineEnd",
          "severity",
          "category",
          "title",
          "description",
          "suggestion",
          "confidence",
        ],
        properties: {
          file: {
            type: "string",
            description: "Repo-relative path, exactly as it appears in the diff.",
          },
          lineStart: {
            type: "integer",
            description:
              "First line of the issue in the post-change file. If unsure, use the smallest range you are confident in.",
          },
          lineEnd: { type: "integer", description: "Last line of the issue, inclusive." },
          severity: {
            type: "string",
            enum: SEVERITY_ORDER,
            description:
              "blocking = ships a bug, vulnerability or data loss. important = likely bug or risky pattern. nit = style or minor maintainability. suggestion = optional improvement.",
          },
          category: { type: "string", enum: CATEGORIES },
          title: {
            type: "string",
            description: "Short phrase naming the problem. No leading severity or category label.",
          },
          description: {
            type: "string",
            description: "One or two sentences on why this is a problem. Never quote a secret value.",
          },
          suggestion: {
            type: "string",
            description: "The concrete fix, phrased as a proposal rather than a command.",
          },
          confidence: {
            type: "number",
            description:
              "0.0-1.0. How sure you are this is a real problem rather than a false positive.",
          },
        },
      },
    },
    annotations: {
      type: "array",
      description:
        "Report-only notes. Never fixed, never approved. Omit or leave empty when there is nothing worth saying.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file", "lineStart", "lineEnd", "severity", "category", "title", "description"],
        properties: {
          file: { type: "string" },
          lineStart: { type: "integer" },
          lineEnd: { type: "integer" },
          severity: { type: "string", enum: ["learning", "praise"] },
          category: { type: "string", enum: CATEGORIES },
          title: { type: "string" },
          description: { type: "string" },
        },
      },
    },
  },
} as const;

export const FINDINGS_SCHEMA_JSON = JSON.stringify(FINDINGS_SCHEMA);
