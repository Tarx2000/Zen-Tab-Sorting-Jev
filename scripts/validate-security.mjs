import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const TEXT_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".ts",
  ".tsx",
  ".txt",
  ".yml",
  ".yaml",
]);
const CODE_EXTENSIONS = new Set([".js", ".mjs", ".ts", ".tsx"]);
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage"]);
const FORBIDDEN_TEXT = [
  [["https://ai.redivo.ru", "/v1"].join(""), "hidden redivo endpoint must not appear"],
  [["FETCH DEBUG", " INFO"].join(""), "fetch debug marker must not appear"],
];
const LEAKED_SECRET_PATTERNS = [
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, "likely OpenAI/provider API key (sk-...)"],
  [/\bAIza[A-Za-z0-9_-]{20,}\b/g, "likely Gemini API key (AIza...)"],
  [/\bgsk_[A-Za-z0-9_-]{20,}\b/g, "likely Groq API key (gsk_...)"],
  [/\bxai-[A-Za-z0-9_-]{20,}\b/g, "likely xAI API key (xai-...)"],
  [/\bpplx-[A-Za-z0-9_-]{20,}\b/g, "likely Perplexity API key (pplx-...)"],
  [/\bghp_[A-Za-z0-9]{20,}\b/g, "likely GitHub personal access token (ghp_...)"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "likely GitHub fine-grained token (github_pat_...)"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "likely raw JWT token (eyJ...)"],
];
const ALLOWLISTED_SECRET_FIXTURES = new Set([
  "tests/security.test.mjs",
  "tests/debug-journal.test.mjs",
  "tests/core-zen-stability.test.mjs",
]);
const LOG_CALL_HEAD_PATTERN =
  /\b(?:console\.(?:debug|error|info|log|warn)|logger\.(?:debug|error|info|warn)|recordDebugEvent)\s*\(/g;
const SECRET_LOG_PATTERNS = [
  [/\bauthorization\b/i, "authorization inside a logging call"],
  [/\bapi[_-]?key\b|\bapiKey\b/i, "API key inside a logging call"],
  [/\brequestBody\b|\bresponseBody\b/i, "raw request/response body inside a logging call"],
  [/\bprompt\b/i, "raw prompt inside a logging call"],
  [/\bheaders\b/i, "headers inside a logging call"],
];
const FLANTIG_URL_PATTERN = /https?:\/\/(?:raw\.githubusercontent\.com|github\.com|codeload\.github\.com)\/flantig\/Zen-Tab-Wand[^\s)"']*/g;

const collectTextFiles = (rootDir, dir = rootDir) => {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) files.push(...collectTextFiles(rootDir, path));
      continue;
    }
    if (stats.isFile() && TEXT_EXTENSIONS.has(extname(path))) files.push(path);
  }
  return files;
};

const formatPath = (rootDir, path) => relative(rootDir, path).split(sep).join("/") || path;

const isAllowedUpstreamCredit = (line) => {
  const lower = line.toLowerCase();
  return lower.includes("based on") || lower.includes("credit") || lower.includes("mit-licensed");
};

const isAllowlistedSecretFixture = (label) =>
  ALLOWLISTED_SECRET_FIXTURES.has(label) || label.startsWith("tests/fixtures/");

const isInsideCommentOrString = (source, index) => {
  let i = 0;
  let state = "code"; // code | single | double | template | line-comment | block-comment
  let templateExprDepth = 0;
  const braceStack = [];

  while (i < index) {
    const ch = source[i];
    const next = source[i + 1];

    if (state === "line-comment") {
      if (ch === "\n") state = "code";
      i += 1;
      continue;
    }
    if (state === "block-comment") {
      if (ch === "*" && next === "/") {
        state = "code";
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (state === "single") {
      if (ch === "\\") { i += 2; continue; }
      if (ch === "'") state = "code";
      i += 1;
      continue;
    }
    if (state === "double") {
      if (ch === "\\") { i += 2; continue; }
      if (ch === '"') state = "code";
      i += 1;
      continue;
    }
    if (state === "template") {
      if (ch === "\\") { i += 2; continue; }
      if (ch === "`") {
        state = "code";
        i += 1;
        continue;
      }
      if (ch === "$" && next === "{") {
        braceStack.push("template");
        templateExprDepth += 1;
        state = "code";
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    // state === "code"
    if (ch === "/" && next === "/") {
      state = "line-comment";
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      state = "block-comment";
      i += 2;
      continue;
    }
    if (ch === "'") { state = "single"; i += 1; continue; }
    if (ch === '"') { state = "double"; i += 1; continue; }
    if (ch === "`") { state = "template"; i += 1; continue; }
    if (ch === "{" && templateExprDepth > 0) {
      braceStack.push("brace");
    } else if (ch === "}" && braceStack.length > 0) {
      const top = braceStack.pop();
      if (top === "template") {
        templateExprDepth -= 1;
        state = "template";
      }
    }
    i += 1;
  }

  return state !== "code";
};

/**
 * Extract full balanced-parenthesis argument lists for every console.*, logger.*,
 * and recordDebugEvent(...) call so nested calls like `console.log(fn(), apiKey)`
 * can never truncate early and bypass secret-log checks.
 */
export const extractLogCalls = (source) => {
  const calls = [];
  LOG_CALL_HEAD_PATTERN.lastIndex = 0;

  let match;
  while ((match = LOG_CALL_HEAD_PATTERN.exec(source)) !== null) {
    const start = match.index;
    const before = source.slice(Math.max(0, start - 24), start);
    if (/\bfunction\s+$/.test(before)) continue;
    if (isInsideCommentOrString(source, start)) continue;

    const argsStart = start + match[0].length;
    let i = argsStart;
    let depth = 1;
    let state = "code";
    const templateBraceStack = [];

    while (i < source.length && depth > 0) {
      const ch = source[i];
      const next = source[i + 1];

      if (state === "line-comment") {
        if (ch === "\n") state = "code";
        i += 1;
        continue;
      }
      if (state === "block-comment") {
        if (ch === "*" && next === "/") {
          state = "code";
          i += 2;
          continue;
        }
        i += 1;
        continue;
      }
      if (state === "single") {
        if (ch === "\\") { i += 2; continue; }
        if (ch === "'") state = "code";
        i += 1;
        continue;
      }
      if (state === "double") {
        if (ch === "\\") { i += 2; continue; }
        if (ch === '"') state = "code";
        i += 1;
        continue;
      }
      if (state === "template") {
        if (ch === "\\") { i += 2; continue; }
        if (ch === "`") { state = "code"; i += 1; continue; }
        if (ch === "$" && next === "{") {
          templateBraceStack.push("template");
          state = "code";
          i += 2;
          continue;
        }
        i += 1;
        continue;
      }

      if (ch === "/" && next === "/") { state = "line-comment"; i += 2; continue; }
      if (ch === "/" && next === "*") { state = "block-comment"; i += 2; continue; }
      if (ch === "'") { state = "single"; i += 1; continue; }
      if (ch === '"') { state = "double"; i += 1; continue; }
      if (ch === "`") { state = "template"; i += 1; continue; }
      if (ch === "{" && templateBraceStack.length > 0) {
        templateBraceStack.push("brace");
      } else if (ch === "}" && templateBraceStack.length > 0) {
        if (templateBraceStack.pop() === "template") state = "template";
      } else if (ch === "(") {
        depth += 1;
      } else if (ch === ")") {
        depth -= 1;
      }
      i += 1;
    }

    if (depth === 0) {
      const argsText = source.slice(argsStart, i - 1);
      calls.push({
        start,
        end: i,
        callText: source.slice(start, i),
        argsText,
      });
    }
  }
  return calls;
};

/**
 * Strip plain prose string literals from call arguments while preserving:
 * - all identifiers, member accesses, and template `${...}` expressions,
 * - quoted object keys (`"api-key": ...`) and bracket keys (`obj["authorization"]`).
 * This catches `console.log(fn(), apiKey)`, `recordDebugEvent("S", "m", { apiKey })`,
 * and `console.log(obj["authorization"])` without false-positiving on localized UI text
 * like `"JEV Stufe 1: API-Key fehlt in den Einstellungen"`.
 */
const stripStaticProseStrings = (argsText) => {
  let out = "";
  let i = 0;
  const templateBraceStack = [];

  while (i < argsText.length) {
    const ch = argsText[i];
    const next = argsText[i + 1];

    if (ch === "/" && next === "/") {
      while (i < argsText.length && argsText[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < argsText.length && !(argsText[i] === "*" && argsText[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }

    if (ch === "'" || ch === '"') {
      const quote = ch;
      const start = i;
      i += 1;
      while (i < argsText.length) {
        if (argsText[i] === "\\") { i += 2; continue; }
        if (argsText[i] === quote) { i += 1; break; }
        i += 1;
      }
      const literal = argsText.slice(start, i);
      const after = argsText.slice(i).trimStart();
      const before = out.trimEnd();
      const isPropertyKey = after.startsWith(":");
      const isBracketKey = before.endsWith("[") && after.startsWith("]");
      out += isPropertyKey || isBracketKey ? literal : '""';
      continue;
    }

    if (ch === "`") {
      i += 1;
      out += " ";
      while (i < argsText.length) {
        if (argsText[i] === "\\") { i += 2; continue; }
        if (argsText[i] === "`") { i += 1; break; }
        if (argsText[i] === "$" && argsText[i + 1] === "{") {
          templateBraceStack.push("template");
          out += " ";
          i += 2;
          break;
        }
        i += 1;
      }
      continue;
    }

    if (ch === "{" && templateBraceStack.length > 0) {
      templateBraceStack.push("brace");
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "}" && templateBraceStack.length > 0) {
      const top = templateBraceStack.pop();
      if (top === "template") {
        i += 1;
        out += " ";
        while (i < argsText.length) {
          if (argsText[i] === "\\") { i += 2; continue; }
          if (argsText[i] === "`") { i += 1; break; }
          if (argsText[i] === "$" && argsText[i + 1] === "{") {
            templateBraceStack.push("template");
            out += " ";
            i += 2;
            break;
          }
          i += 1;
        }
        continue;
      }
    }

    out += ch;
    i += 1;
  }

  return out;
};

export const collectFileErrors = (rootDir, filePath) => {
  const source = readFileSync(filePath, "utf8");
  const label = formatPath(rootDir, filePath);
  const errors = [];

  for (const [needle, message] of FORBIDDEN_TEXT) {
    if (source.includes(needle)) errors.push(`${label}: ${message}`);
  }

  if (!isAllowlistedSecretFixture(label)) {
    for (const [pattern, message] of LEAKED_SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of source.matchAll(pattern)) {
        const token = match[0];
        if (!token.includes("[redacted]")) errors.push(`${label}: ${message}`);
      }
    }
  }

  if (CODE_EXTENSIONS.has(extname(filePath)) && !isAllowlistedSecretFixture(label)) {
    for (const { argsText } of extractLogCalls(source)) {
      const inspectable = stripStaticProseStrings(argsText);
      for (const [pattern, message] of SECRET_LOG_PATTERNS) {
        if (pattern.test(inspectable)) errors.push(`${label}: ${message}`);
      }
    }
  }

  const lines = source.split(/\r?\n/);
  lines.forEach((line, index) => {
    FLANTIG_URL_PATTERN.lastIndex = 0;
    if (!FLANTIG_URL_PATTERN.test(line)) return;
    FLANTIG_URL_PATTERN.lastIndex = 0;
    if (!isAllowedUpstreamCredit(line)) {
      errors.push(`${label}:${index + 1}: public install URL must point to LoopRook/Zen-Tab-Sorting`);
    }
  });

  return errors;
};

export const validateSecurity = (rootDir = process.cwd()) => {
  const errors = collectTextFiles(rootDir).flatMap((filePath) => collectFileErrors(rootDir, filePath));
  return { ok: errors.length === 0, errors };
};

const isCli = process.argv[1] === fileURLToPath(import.meta.url);

if (isCli) {
  const result = validateSecurity();
  if (!result.ok) {
    console.error(result.errors.join("\n"));
    process.exit(1);
  }
  console.log("validate-security: PASS no legacy endpoint/debug/leaked secrets/raw secret logs");
}
