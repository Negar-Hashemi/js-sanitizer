// sanitizer.js
// Babel plugin: js-sanitizer
// Skips tests (test/it/describe) based on docblock tags.

const fs = require("fs");
const path = require("path");
const { extract, parse } = require("jest-docblock");

module.exports = function jsSanitizer(babel) {
  const { types: t } = babel;

  const currentPlatform = process.platform; // "darwin" | "win32" | "linux"
  const currentNodeVersion = parseInt(process.versions.node.split(".")[0], 10);
  const currentBrowser = detectBrowser();

  const reportDir = fs.existsSync(path.resolve(process.cwd(), "reports"))
    ? path.resolve(process.cwd(), "reports")
    : process.cwd();
  const logFilePath = path.join(reportDir, "sanitize-tests.log");

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
        // Skip if we can’t detect a browser, or current not in list
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
        return currentNodeVersion >= min && currentNodeVersion <= max;
      },
      format: (value) => `@skipForNodeRange ${value}`,
    },
    {
      tag: "enabledForNodeRange",
      shouldSkip: (value) => {
        const { min, max } = parseRange(value);
        return currentNodeVersion < min || currentNodeVersion > max;
      },
      format: (value) => `@enabledForNodeRange ${value}`,
    },
  ];

  // --- Helpers ---

  function detectBrowser() {
    if (process?.env?.JS_SANITIZER_BROWSER) return process.env.JS_SANITIZER_BROWSER;
    if (typeof navigator === "undefined" || !navigator.userAgent) return null;
    const ua = navigator.userAgent;
    if (ua.includes("Firefox")) return "Firefox";
    if (ua.includes("Edg")) return "Edge";
    if (ua.includes("Chrome")) return "Chrome";
    if (ua.includes("Safari") && !ua.includes("Chrome") && !ua.includes("Chromium")) return "Safari";
    return null;
  }

  function parseList(str) {
    return String(str || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function parseVersionList(str) {
    return parseList(str)
      .map((v) => parseInt(v, 10))
      .filter((v) => Number.isFinite(v));
  }

  function parseRange(str) {
    const pairs = {};
    String(str || "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
      .forEach((pair) => {
        const [k, v] = pair.split("=").map((x) => x.trim());
        if (k && v) pairs[k] = v;
      });
    return {
      min: pairs.min ? parseInt(pairs.min, 10) : -Infinity,
      max: pairs.max ? parseInt(pairs.max, 10) : Infinity,
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
            const pragmas = parse(docblock);

            for (const { tag, shouldSkip, format } of tagHandlers) {
              const value = pragmas[tag];
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
