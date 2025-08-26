// sanitizer.js
// Babel plugin: js-sanitizer
// Skips tests (test/it/describe) based on docblock tags (NOW CASE-INSENSITIVE).

const fs = require("fs");
const path = require("path");
const { extract, parse } = require("jest-docblock");

module.exports = function jsSanitizer(babel) {
  const { types: t } = babel;

  // --- Environment (normalized) ---
  const currentPlatform = String(process.platform).toLowerCase(); // 'darwin' | 'win32' | 'linux'
  const currentNodeVersion = (() => {
    // major version as integer, tolerant to formats like 'v20.11.1'
    const m = String(process.versions.node).match(/\d+/);
    return m ? parseInt(m[0], 10) : NaN;
  })();
  const currentBrowser = detectBrowser(); // normalized to lowercase string or null

  // --- Reporting ---
  const reportDir = path.resolve(process.cwd(), "reports");

  // Ensure the reports directory exists
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }
  const logFilePath = path.join(reportDir, "environment-sanitized-tests.log");

  // --- Tag handlers (tag names are matched case-insensitively) ---
  const tagHandlers = [
    {
      tag: "skipOnBrowser",
      shouldSkip: (value) => {
        const list = parseList(value);
        return currentBrowser && list.includes(currentBrowser);
      },
      format: (value) => `@skipOnBrowser ${value}`,
    },
    {
      tag: "enabledOnBrowser",
      shouldSkip: (value) => {
        const list = parseList(value);
        // Skip if we can't detect a browser, or current not in list
        return !currentBrowser || !list.includes(currentBrowser);
      },
      format: (value) => `@enabledOnBrowser ${value}`,
    },
    {
      tag: "skipOnOS",
      shouldSkip: (value) => parseList(value).includes(currentPlatform),
      format: (value) => `@skipOnOS ${value}`,
    },
    {
      tag: "enabledOnOS",
      shouldSkip: (value) => !parseList(value).includes(currentPlatform),
      format: (value) => `@enabledOnOS ${value}`,
    },
    {
      tag: "skipOnNodeVersion",
      shouldSkip: (value) => parseVersionList(value).includes(currentNodeVersion),
      format: (value) => `@skipOnNodeVersion ${value}`,
    },
    {
      tag: "enabledOnNodeVersion",
      shouldSkip: (value) => !parseVersionList(value).includes(currentNodeVersion),
      format: (value) => `@enabledOnNodeVersion ${value}`,
    },
    {
      tag: "skipForNodeRange",
      shouldSkip: (value) => {
        const { min, max } = parseRange(value);
        return currentNodeVersion >= min && currentNodeVersion <= max; // inclusive
      },
      format: (value) => `@skipForNodeRange ${value}`,
    },
    {
      tag: "enabledForNodeRange",
      shouldSkip: (value) => {
        const { min, max } = parseRange(value);
        return currentNodeVersion < min || currentNodeVersion > max; // outside the inclusive range
      },
      format: (value) => `@enabledForNodeRange ${value}`,
    },
  ];

  // --- Helpers ---

  function detectBrowser() {
    if (process?.env?.JS_SANITIZER_BROWSER) {
      return String(process.env.JS_SANITIZER_BROWSER).trim().toLowerCase();
    }
    if (typeof navigator === "undefined" || !navigator.userAgent) return null;
    const ua = navigator.userAgent;
    if (ua.includes("Firefox")) return "firefox";
    if (ua.includes("Edg")) return "edge";
    if (ua.includes("Chrome")) return "chrome";
    if (ua.includes("Safari") && !ua.includes("Chrome") && !ua.includes("Chromium")) return "safari";
    return null;
  }

  // Split comma lists, trim, and lowercase values.
  function parseList(str) {
    return String(str || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }

  // Accept versions like "18", "v20", "20.11.1" → returns majors [18,20,...]
  function parseVersionList(str) {
    return parseList(str)
      .map((tok) => {
        const m = tok.match(/\d+/);
        return m ? parseInt(m[0], 10) : NaN;
      })
      .filter((v) => Number.isFinite(v));
  }

  // Parse "min=16,max=18" (case-insensitive keys/values), inclusive range based on majors.
  function parseRange(str) {
    const pairs = {};
    String(str || "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
      .forEach((pair) => {
        const [kRaw, vRaw] = pair.split("=").map((x) => x.trim().toLowerCase());
        if (kRaw && vRaw) pairs[kRaw] = vRaw;
      });
    const toMajor = (s) => {
      const m = String(s).match(/\d+/);
      return m ? parseInt(m[0], 10) : null;
    };
    const min = pairs.min ? toMajor(pairs.min) : null;
    const max = pairs.max ? toMajor(pairs.max) : null;
    return {
      min: min ?? -Infinity,
      max: max ?? Infinity,
    };
  }

  function logMessage(msg) {
    const ts = new Date().toISOString();
    try {
      fs.appendFileSync(logFilePath, `[${ts}] ${msg}\n`, "utf8");
    } catch {
      /* ignore logging errors */
    }
  }

  // ---- NEW: robust callee analysis (handles X, X.only, X.skip) ----
  function analyzeCallee(callee) {
    // Allowed bases (do NOT add new names to avoid changing behavior)
    const TESTS = new Set(["test", "it"]);
    const SUITES = new Set(["describe"]);

    if (t.isIdentifier(callee)) {
      const base = callee.name;
      if (TESTS.has(base) || SUITES.has(base)) return { base, mod: null };
      return null;
    }
    if (t.isMemberExpression(callee) && t.isIdentifier(callee.object)) {
      const base = callee.object.name;
      if (!(new Set([...TESTS, ...SUITES]).has(base))) return null;
      let mod = null;
      if (t.isIdentifier(callee.property)) mod = callee.property.name;
      else if (t.isStringLiteral(callee.property)) mod = callee.property.value;
      return { base, mod };
    }
    return null;
  }

  // ---- NEW: prefer docblock on ExpressionStatement (common case), with fallbacks ----
  function getDocblockPragmas(path) {
    const collectLeading = (node) =>
      node && node.leadingComments ? node.leadingComments : [];

    // 1) Most docblocks attach to the ExpressionStatement that wraps the call
    const exprNode =
      path.parentPath && path.parentPath.isExpressionStatement()
        ? path.parentPath.node
        : null;
    let comments = collectLeading(exprNode);

    // 2) Fallback: use the CallExpression's own leading comments
    if (!comments || comments.length === 0) comments = collectLeading(path.node);

    // 3) Fallback: one more level up (rare)
    if (
      (!comments || comments.length === 0) &&
      path.parentPath &&
      path.parentPath.parent
    ) {
      comments = collectLeading(path.parentPath.parent);
    }

    if (!comments || comments.length === 0) return null;

    // Choose the closest preceding block comment
    const lastBlock = [...comments].reverse().find((c) => c.type === "CommentBlock");
    if (!lastBlock) return null;

    try {
      const raw = "/*" + lastBlock.value + "*/";
      const docblock = extract(raw);
      const pragmas = parse(docblock) || {};

      // Lowercase keys for case-insensitive lookup
      const pragmasLC = Object.create(null);
      for (const [k, v] of Object.entries(pragmas)) {
        pragmasLC[String(k).toLowerCase()] = v;
      }
      return pragmasLC;
    } catch {
      return null;
    }
  }

  // ---- NEW: force any variant (X or X.only) to X.skip ----
  function forceSkipCallee(callee, baseName) {
    // it(...) -> it.skip(...)
    if (t.isIdentifier(callee)) {
      return t.memberExpression(t.identifier(baseName), t.identifier("skip"));
    }
    // it.only(...) / it.xxx(...) -> it.skip(...)
    if (t.isMemberExpression(callee) && t.isIdentifier(callee.object)) {
      return t.memberExpression(t.identifier(baseName), t.identifier("skip"));
    }
    return callee;
  }

  // --- Core ---

  return {
    name: "js-sanitizer",
    visitor: {
      CallExpression(path, state) {
        const filename = state.file.opts.filename || "";
        const info = analyzeCallee(path.node.callee);
        if (!info) return;

        const { base, mod } = info;
        // Respect existing .skip; we may override .only if a pragma says skip
        if (mod === "skip") return;

        const args = path.node.arguments;
        const testName =
          args[0]?.type === "StringLiteral" ? args[0].value : "(unnamed)";

        const pragmasLC = getDocblockPragmas(path);
        if (!pragmasLC) return;

        // Use your existing handlers, matching keys case-insensitively
        for (const { tag, shouldSkip, format } of tagHandlers) {
          const value = pragmasLC[String(tag).toLowerCase()];
          if (!value) continue;
          if (shouldSkip(value)) {
            const newCallee = forceSkipCallee(path.node.callee, base);
            path.get("callee").replaceWith(newCallee);

            const msg = `[SKIPPING] ${base}("${testName}") in ${filename} due to ${format(
              value
            )}`;
            console.warn(msg);
            logMessage(msg);
            return;
          }
        }
      },
    },
  };
};
