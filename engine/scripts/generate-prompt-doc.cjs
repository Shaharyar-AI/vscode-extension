const fs = require("node:fs");
const path = require("node:path");
const E = __dirname;
const { buildPrompt, USER_PROMPT, USER_PROMPT_FILES } = require(path.join(E, "dist", "prompt.js"));
const { guidesFor } = require(path.join(E, "dist", "languages.js"));
const { DEFAULT_CONFIG } = require(path.join(E, "dist", "types.js"));

const refs = path.resolve(E, "..", "extension", "resources", "references");
const { systemPrompt, guidesLoaded } = buildPrompt(
  guidesFor(["src/payments.ts"]), DEFAULT_CONFIG, refs, [],
);
const F = "```";
const doc = `# CR-Track — the prompt sent to Claude

Everything below is what CR-Track sends for a code review. Nothing is
paraphrased: the system prompt is the exact text the model receives, generated
by running the extension's own prompt builder.

## How it is invoked

${F}
claude -p "<user prompt below>" \
  --model claude-opus-5 \
  --effort medium \
  --tools Read,Grep,Glob \
  --permission-mode dontAsk \
  --append-system-prompt-file <the system prompt below> \
  --json-schema <findings schema> \
  --output-format json \
  --add-dir <repo root> \
  --no-session-persistence
${F}

The unified diff for the commit goes in on **stdin**.

Read, Grep and Glob are the only tools granted, so the reviewer can read
surrounding code for context but cannot write, execute or fetch anything.
Sessions are not persisted. Reviews run on the developer's own machine against
their own Claude account; only the redacted report is uploaded.

## What comes back

Two arrays, against a JSON schema the CLI enforces:

- **findings** — fixable problems, each with a severity, category, file, line
  range, description, suggestion and confidence.
- **annotations** — report-only notes (\`learning\` and \`praise\`). Never fixed,
  never approved, never applied.

## User prompt

${F}
${USER_PROMPT}
${F}

For a whole-file review (no diff available) it is replaced by:

${F}
${USER_PROMPT_FILES}
${F}

## System prompt

Assembled per review: a fixed preamble and rule set, plus only the guides
relevant to the languages in the diff. The copy below is for a TypeScript
change — ${systemPrompt.length} characters.

Sections included: ${guidesLoaded.join(", ")}.

---

${systemPrompt}
`;
fs.writeFileSync(path.join(E, "..", "docs", "PROMPT.md"), doc, "utf8");
console.log("regenerated — system prompt " + systemPrompt.length + " chars");
