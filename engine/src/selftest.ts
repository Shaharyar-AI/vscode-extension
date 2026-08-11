/**
 * Self-test for the pure logic — envelope unwrapping, filtering, numbering,
 * cache-key stability. No CLI, no network, no git.
 *
 *   node dist/selftest.js
 */

import { cacheKeyFor, extractResult, filterFindings, numberFindings } from "./review";
import { compareVersions } from "./claude-cli";
import { redactDeep, redactString } from "./redact";
import { guidesFor, languageFor, primaryLanguage } from "./languages";
import { DEFAULT_CONFIG, type RawFinding } from "./types";

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}\n          ${(err as Error).message}`);
  }
}
function eq(actual: unknown, expected: unknown, what = ""): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}expected ${e}, got ${a}`);
}

const finding = (over: Partial<RawFinding> = {}): RawFinding => ({
  file: "src/a.ts",
  lineStart: 10,
  lineEnd: 10,
  severity: "important",
  category: "correctness",
  title: "t",
  description: "d",
  suggestion: "s",
  confidence: 0.9,
  ...over,
});

console.log("\nenvelope unwrapping");
check("bare payload", () => {
  eq(extractResult('{"findings":[]}').findings, []);
});
check("wrapped in .result as an object", () => {
  eq(extractResult('{"type":"result","result":{"findings":[]}}').findings, []);
});
check("wrapped in .result as a JSON string", () => {
  eq(extractResult('{"result":"{\\"findings\\":[]}"}').findings, []);
});
check("wrapped in .structured_output", () => {
  eq(extractResult('{"structured_output":{"findings":[]}}').findings, []);
});
check("log noise before the JSON body", () => {
  eq(extractResult('warming up\nfetching\n{"findings":[]}').findings, []);
});
check("keeps the findings it finds", () => {
  const r = extractResult(JSON.stringify({ result: { findings: [finding()] } }));
  eq(r.findings.length, 1);
  eq(r.findings[0]!.title, "t");
});
check("empty stdout throws", () => {
  try {
    extractResult("   ");
    throw new Error("should have thrown");
  } catch (e) {
    if (!/empty stdout/.test((e as Error).message)) throw e;
  }
});
check("no findings key throws", () => {
  try {
    extractResult('{"ok":true}');
    throw new Error("should have thrown");
  } catch (e) {
    if (!/no `findings` array/.test((e as Error).message)) throw e;
  }
});

console.log("\nfiltering");
check("drops disabled categories", () => {
  const cfg = { ...DEFAULT_CONFIG, categoriesEnabled: ["security" as const] };
  eq(filterFindings([finding({ category: "style" })], cfg).length, 0);
});
check("drops below min severity", () => {
  const cfg = { ...DEFAULT_CONFIG, minSeverity: "important" as const };
  eq(filterFindings([finding({ severity: "nit" })], cfg).length, 0);
  eq(filterFindings([finding({ severity: "blocking" })], cfg).length, 1);
});
check("balanced drops low-confidence nits but keeps blocking", () => {
  const cfg = DEFAULT_CONFIG;
  eq(filterFindings([finding({ severity: "nit", confidence: 0.2 })], cfg).length, 0);
  eq(filterFindings([finding({ severity: "blocking", confidence: 0.2 })], cfg).length, 1);
});
check("chill keeps only blocking and important", () => {
  const cfg = { ...DEFAULT_CONFIG, profile: "chill" as const };
  eq(filterFindings([finding({ severity: "nit", confidence: 1 })], cfg).length, 0);
  eq(filterFindings([finding({ severity: "important" })], cfg).length, 1);
});
check("assertive keeps low-confidence suggestions", () => {
  const cfg = { ...DEFAULT_CONFIG, profile: "assertive" as const, minSeverity: "suggestion" as const };
  eq(filterFindings([finding({ severity: "suggestion", confidence: 0.1 })], cfg).length, 1);
});
check("survives a malformed finding", () => {
  eq(filterFindings([null as never, finding()], DEFAULT_CONFIG).length, 1);
});

console.log("\nnumbering");
check("severity, then path, then line", () => {
  const ids = numberFindings([
    finding({ severity: "nit", file: "src/z.ts", lineStart: 1 }),
    finding({ severity: "blocking", file: "src/b.ts", lineStart: 50 }),
    finding({ severity: "blocking", file: "src/a.ts", lineStart: 99 }),
    finding({ severity: "important", file: "src/a.ts", lineStart: 2 }),
  ]).map((f) => `${f.id}:${f.severity}:${f.file}`);
  eq(ids, [
    "f1:blocking:src/a.ts",
    "f2:blocking:src/b.ts",
    "f3:important:src/a.ts",
    "f4:nit:src/z.ts",
  ]);
});
check("stable across input order", () => {
  const a = [finding({ file: "b.ts" }), finding({ file: "a.ts" })];
  const b = [finding({ file: "a.ts" }), finding({ file: "b.ts" })];
  eq(numberFindings(a).map((f) => f.file), numberFindings(b).map((f) => f.file));
});

console.log("\ncache key");
check("stable for identical input", () => {
  eq(cacheKeyFor("diff", DEFAULT_CONFIG, ["typescript"]), cacheKeyFor("diff", DEFAULT_CONFIG, ["typescript"]));
});
check("changes with the diff", () => {
  if (cacheKeyFor("a", DEFAULT_CONFIG, []) === cacheKeyFor("b", DEFAULT_CONFIG, []))
    throw new Error("key did not change");
});
check("changes with effort", () => {
  const other = { ...DEFAULT_CONFIG, effort: "high" as const };
  if (cacheKeyFor("d", DEFAULT_CONFIG, []) === cacheKeyFor("d", other, []))
    throw new Error("key did not change");
});
check("insensitive to category order", () => {
  const a = { ...DEFAULT_CONFIG, categoriesEnabled: ["security" as const, "docs" as const] };
  const b = { ...DEFAULT_CONFIG, categoriesEnabled: ["docs" as const, "security" as const] };
  eq(cacheKeyFor("d", a, []), cacheKeyFor("d", b, []));
});

console.log("\nlanguages");
check("extension mapping", () => {
  eq(languageFor("src/a.tsx"), "TypeScript");
  eq(languageFor("main.go"), "Go");
  eq(languageFor("LICENSE"), null);
});
check("guides are deduped and sorted", () => {
  eq(guidesFor(["a.ts", "b.tsx", "c.py", "d.rs", "e.js"]), ["javascript", "python", "typescript"]);
});
check("no guide for unmapped languages", () => {
  eq(guidesFor(["a.rs", "b.md"]), []);
});
check("primary language is the most common", () => {
  eq(primaryLanguage(["a.py", "b.py", "c.ts"]), "Python");
  eq(primaryLanguage(["LICENSE"]), null);
});

console.log("\nredaction");
check("private keys", () => {
  const t = redactString("key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----").text;
  if (/MIIabc/.test(t)) throw new Error("key body survived");
});
check("provider tokens", () => {
  for (const secret of [
    "AKIAIOSFODNN7EXAMPLE",
    "ghp_" + "a".repeat(36),
    "xoxb-1234567890-abcdefghij",
    "AIza" + "b".repeat(35),
    "sk_live_" + "c".repeat(24),
  ]) {
    const t = redactString(`value ${secret} here`).text;
    if (t.includes(secret)) throw new Error(`leaked: ${secret.slice(0, 8)}…`);
  }
});
check("jwt", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
  if (redactString(jwt).text.includes("dozjgNryP4J3")) throw new Error("jwt survived");
});
check("assignment keeps the key, drops the value", () => {
  const t = redactString('const password = "hunter2hunter2"').text;
  if (t.includes("hunter2hunter2")) throw new Error("value survived");
  if (!t.includes("password")) throw new Error("key name should be kept for readability");
});
check("credentials in a URL", () => {
  const t = redactString("postgres://admin:s3cretpass@db.internal:5432/app").text;
  if (t.includes("s3cretpass")) throw new Error("password survived");
  if (!t.includes("db.internal")) throw new Error("host should survive");
});
check("long hex and base64 blobs", () => {
  if (redactString("h " + "a1b2c3d4".repeat(5)).text.includes("a1b2c3d4a1b2")) throw new Error("hex survived");
  if (redactString("b " + "QUJDRA".repeat(9)).text.includes("QUJDRAQUJDRA")) throw new Error("base64 survived");
});
check("ordinary prose is untouched", () => {
  const prose = "Consider a parameterized query on line 42 of src/db.ts.";
  eq(redactString(prose).text, prose);
});
check("redactDeep walks nested structures and reports hits", () => {
  const r = redactDeep({
    findings: [{ title: "leak", description: "token = abcdefghijklmnop", nested: { n: 1 } }],
  });
  const desc = (r.value as any).findings[0].description as string;
  if (desc.includes("abcdefghijklmnop")) throw new Error("nested value survived");
  if ((r.value as any).findings[0].nested.n !== 1) throw new Error("non-strings must survive");
  if (!r.hits.includes("assignment")) throw new Error("hit not reported");
});
check("redactDeep leaves keys alone", () => {
  const r = redactDeep({ password: "short" });
  if (!Object.keys(r.value as object).includes("password")) throw new Error("key was mangled");
});

console.log("\nversion comparison");
check("orders correctly", () => {
  if (compareVersions("2.1.0", "2.0.9") <= 0) throw new Error("2.1.0 > 2.0.9");
  if (compareVersions("2.0.0", "2.0.0") !== 0) throw new Error("equal");
  if (compareVersions("1.9.9", "2.0.0") >= 0) throw new Error("1.9.9 < 2.0.0");
  if (compareVersions("2.10.0", "2.9.0") <= 0) throw new Error("numeric, not lexical");
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
