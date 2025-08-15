const fs = require('fs');
const path = require('path');
const { extract, parse } = require('jest-docblock');

module.exports = function(babel, options = {}) {
  const { types: t } = babel;

  const currentPlatform = process.platform;
  const currentNodeVersion = parseInt(process.versions.node.split('.')[0], 10);
  const currentBrowsers = detectBrowser();

  const logFilePath = path.resolve(process.cwd(), 'sanitize-tests.log');

  const tagHandlers = [
    { 
      tag: 'skipOnBrowser',
      shouldSkip: (value) => parseList(value).includes(currentBrowsers),
      format: (value) => `@skipOnBrowser ${value}`
    },
    { 
      tag: 'enableOnBrowser',
      shouldSkip: (value) => !parseList(value).includes(currentBrowsers),
      format: (value) => `@enableOnBrowser ${value}`
    },
    { 
      tag: 'skipOnOS',
      shouldSkip: (value) => parseList(value).includes(currentPlatform),
      format: (value) => `@skipOnOS ${value}`
    },
    {
      tag: 'enabledOnOS',
      shouldSkip: (value) => !parseList(value).includes(currentPlatform),
      format: (value) => `@enabledOnOS ${value}`
    },
    {
      tag: 'skipOnNodeVersion',
      shouldSkip: (value) => parseVersionList(value).includes(currentNodeVersion),
      format: (value) => `@skipOnNodeVersion ${value}`
    },
    {
      tag: 'enabledOnNodeVersion',
      shouldSkip: (value) => !parseVersionList(value).includes(currentNodeVersion),
      format: (value) => `@enabledOnNodeVersion ${value}`
    },
    {
      tag: 'skipForNodeRange',
      shouldSkip: (value) => {
        const { minVersions, maxVersions } = parseKeyValue(value);
        const min = minVersions ? parseInt(minVersions, 10) : -Infinity;
        const max = maxVersions ? parseInt(maxVersions, 10) : Infinity;
        return currentNodeVersion >= min && currentNodeVersion <= max;
      },
      format: (value) => `@skipForNodeRange ${value}`
    },
    {
      tag: 'enabledForNodeRange',
      shouldSkip: (value) => {
        const { minVersions, maxVersions } = parseKeyValue(value);
        const min = minVersions ? parseInt(minVersions, 10) : -Infinity;
        const max = maxVersions ? parseInt(maxVersions, 10) : Infinity;
        return currentNodeVersion < min || currentNodeVersion > max;
      },
      format: (value) => `@enabledForNodeRange ${value}`
    }
  ];

  function detectBrowser() {
    if (typeof navigator === 'undefined') return 'Node';
    const ua = navigator.userAgent;
    if (ua.includes("Firefox")) return "Firefox";
    if (ua.includes("Edg")) return "Edge";
    if (ua.includes("Chrome")) return "Chrome";
    if (ua.includes("Safari")) return "Safari";
    return "Unknown";
  }

  function shouldSkipTest(pragmas) {
    for (const { tag, shouldSkip, format } of tagHandlers) {
      const value = pragmas[tag];
      if (!value) continue;

      if (shouldSkip(value)) {
        return format(value);
      }
    }
    return null;
  }

  function parseList(str) {
    return str.split(',').map(s => s.trim());
  }

  function parseVersionList(str) {
    return str ? parseList(str).map(v => parseInt(v, 10)).filter(v => !isNaN(v)) : [];
  }

  function parseKeyValue(str) {
    const result = {};
    str.split(',').forEach(pair => {
      const [key, value] = pair.split('=').map(s => s.trim());
      if (key && value) result[key] = value;
    });
    return result;
  }

  function logMessage(message) {
    const timestamp = new Date().toISOString();
    fs.appendFileSync(logFilePath, `[${timestamp}] ${message}\n`, 'utf8');
  }

  return {
    visitor: {
      CallExpression(path) {
        const callee = path.get('callee');
        const calleeName = callee.node.name;

        if (!['test', 'it', 'describe'].includes(calleeName)) return;

        const args = path.node.arguments;
        const testName = args[0]?.type === 'StringLiteral' ? args[0].value : '(unnamed)';
        const fileName = path.hub?.file?.opts?.filename || '(unknown file)';

        const comments = path.node.leadingComments || path.parent.leadingComments || [];
        if (!comments.length) return;

        for (const comment of comments) {
          if (!comment.value.startsWith('*')) continue;

          try {
            const makeDocblock = "/*" + comment.value + "*/";
            const docblock = extract(makeDocblock);
            const pragmas = parse(docblock);

            const skipReason = shouldSkipTest(pragmas);
            if (skipReason) {
              const newCallee = t.memberExpression(
                t.identifier(calleeName),
                t.identifier('skip')
              );
              callee.replaceWith(newCallee);

              const message = `[SKIPPING] ${calleeName}("${testName}") in ${fileName} due to ${skipReason}`;
              console.log(message);
              logMessage(message);

              return;
            }
          } catch (err) {
            const warnMessage = `[WARN] Failed to process comment in ${fileName}: ${err.message}`;
            console.warn(warnMessage);
            logMessage(warnMessage);
          }
        }
      }
    }
  };
};
