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
  const reportDir = fs.existsSync(path.resolve(process.cwd(), "reports"))
    ? path.resolve(process.cwd(), "reports")
    : process.cwd();
  const logFilePath = path.join(reportDir, "sanitize-tests.log");

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

  function nearestBlockComments(path) {
    const here = path.node.leadingComments || [];
    if (here.length) return here;
    return path.parent?.leadingComments || [];
  }

  function baseTestName(node) {
    if (t.isIdentifier(node)) return node.name;
    if (t.isMemberExpression(node) && t.isIdentifier(node.object)) {
      return node.object.name;
    }
    return null;
  }

  function forceSkip(node) {
    if (t.isIdentifier(node)) {
      return t.memberExpression(node, t.identifier("skip"));
    }
    if (t.isMemberExpression(node) && t.isIdentifier(node.object)) {
      return t.memberExpression(node.object, t.identifier("skip"));
    }
    return node;
  }

  // --- Core ---

  return {
    name: "js-sanitizer",
    visitor: {
      CallExpression(path, state) {
        const filename = state.file.opts.filename || "";
        const calleeNode = path.node.callee;
        const baseName = baseTestName(calleeNode);

        if (!baseName || !["test", "it", "describe"].includes(baseName)) return;
        if (t.isMemberExpression(calleeNode) && t.isIdentifier(calleeNode.property, { name: "skip" })) {
          return; // already skipped
        }

        const args = path.node.arguments;
        const testName = args[0]?.type === "StringLiteral" ? args[0].value : "(unnamed)";
        const comments = nearestBlockComments(path);
        if (!comments.length) return;

        for (const comment of comments) {
          if (comment.type !== "CommentBlock") continue;
          try {
            const raw = "/*" + comment.value + "*/";
            const docblock = extract(raw);
            const pragmas = parse(docblock) || {};

            // Build a lowercased pragma map for case-insensitive tag lookup.
            const pragmasLC = Object.create(null);
            for (const [k, v] of Object.entries(pragmas)) {
              pragmasLC[String(k).toLowerCase()] = v;
            }

            for (const { tag, shouldSkip, format } of tagHandlers) {
              const value = pragmasLC[String(tag).toLowerCase()];
              if (!value) continue;
              if (shouldSkip(value)) {
                const newCallee = forceSkip(calleeNode);
                path.get("callee").replaceWith(newCallee);

                const msg = `[SKIPPING] ${baseName}("${testName}") in ${filename} due to ${format(value)}`;
                console.warn(msg);
                logMessage(msg);
                return;
              }
            }
          } catch (err) {
            const warn = `[WARN] Failed to process comment in ${filename}: ${err.message}`;
            console.warn(warn);
            logMessage(warn);
          }
        }
      },
    },
  };
};
