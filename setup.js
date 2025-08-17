#!/usr/bin/env node
/**
 * js-sanitizer setup
 * - Works from the consumer project root using INIT_CWD
 * - Wires Babel plugin, Jest (babel-jest), Mocha (@babel/register), Vitest (@babel/register)
 * - Idempotent + conservative
 */
const fs = require('fs');
const path = require('path');

// Resolve the REAL project root (npm/yarn supply INIT_CWD)
const ROOT = process.env.INIT_CWD || process.cwd();
const log = (m) => console.log(`[js-sanitizer setup] ${m}`);

if (process.env.JS_SANITIZER_SKIP_SETUP === '1') {
  log('Skipping due to JS_SANITIZER_SKIP_SETUP=1');
  process.exit(0);
}

const PLUGIN_NAME = 'module:js-sanitizer';
const PKG_PATH = path.join(ROOT, 'package.json');
const JEST_FILES = [
  'jest.config.js',
  'jest.config.cjs',
  // We avoid automatic edits for .mjs/.ts to prevent risky rewrites
  // 'jest.config.mjs',
  // 'jest.config.ts'
].map(f => path.join(ROOT, f));
const MOCHA_RC = path.join(ROOT, '.mocharc.json');
const BABEL_REGISTER = path.join(ROOT, 'babel.register.js');
const VITEST_SETUP = path.join(ROOT, 'vitest.setup.js');

const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
const readJSON = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const writeJSON = (p, o) => fs.writeFileSync(p, JSON.stringify(o, null, 2) + '\n');
const writeIfChanged = (p, s) => {
  const str = String(s);
  if (exists(p) && fs.readFileSync(p, 'utf8') === str) return false;
  fs.writeFileSync(p, str);
  return true;
};
const ensureArray = (x) => (Array.isArray(x) ? x : (x == null ? [] : [x]));
const pkg = readJSON(PKG_PATH) || {};
const hasAnyDep = (name) =>
  !!(pkg.dependencies?.[name] || pkg.devDependencies?.[name] || pkg.peerDependencies?.[name]);

log(`Using project root: ${ROOT}`);

// ----------------- 1) Ensure Babel config includes plugin -----------------
(function ensureBabelConfig() {
  const jsonPaths = ['.babelrc', '.babelrc.json'].map(f => path.join(ROOT, f));
  const jsPath = path.join(ROOT, 'babel.config.js');

  for (const p of jsonPaths) {
    if (!exists(p)) continue;
    const cfg = readJSON(p) || {};
    cfg.plugins = ensureArray(cfg.plugins);
    if (!cfg.plugins.includes(PLUGIN_NAME)) {
      cfg.plugins.push(PLUGIN_NAME);
      writeJSON(p, cfg);
      log(`Added ${PLUGIN_NAME} to ${path.basename(p)}`);
    } else {
      log(`${PLUGIN_NAME} already present in ${path.basename(p)}`);
    }
    return;
  }

  if (exists(jsPath)) {
    let src = fs.readFileSync(jsPath, 'utf8');
    if (src.includes(PLUGIN_NAME)) {
      log(`${PLUGIN_NAME} already present in ${path.basename(jsPath)}`);
      return;
    }
    const pluginsArrayRegex = /plugins\s*:\s*\[([\s\S]*?)\]/m;
    if (pluginsArrayRegex.test(src)) {
      src = src.replace(pluginsArrayRegex, (m, inner) => {
        const trimmed = inner.trim();
        const needsComma = trimmed && !trimmed.endsWith(',');
        const insertion = (needsComma ? inner + ' ' : inner) + `'${PLUGIN_NAME}',`;
        return `plugins: [${insertion}]`;
      });
    } else {
      // Add a plugins field after "module.exports = {"
      src = src.replace(/module\.exports\s*=\s*\{/, match => {
        return `${match}\n  plugins: ['${PLUGIN_NAME}'],`;
      });
    }
    writeIfChanged(jsPath, src);
    log(`Ensured ${PLUGIN_NAME} in ${path.basename(jsPath)}`);
    return;
  }

  // Create a minimal babel.config.js
  const content =
`module.exports = {
  presets: [
    ["@babel/preset-env", { targets: { node: "current" } }]
  ],
  plugins: ['${PLUGIN_NAME}'],
  comments: true
};
`;
  fs.writeFileSync(jsPath, content);
  log(`Created ${path.basename(jsPath)} with ${PLUGIN_NAME}`);
})();

// ----------------- 2) Jest wiring (babel-jest) -----------------
(function ensureJest() {
  if (!hasAnyDep('jest')) {
    log('Jest not detected — skipping Jest wiring.');
    return;
  }
  const hasBabelJest = hasAnyDep('babel-jest');
  if (!hasBabelJest) {
    log('WARNING: babel-jest not found. Install it so Babel (and js-sanitizer) runs in Jest: npm i -D babel-jest');
  }

  // A) package.json "jest" block
  if (pkg.jest && typeof pkg.jest === 'object') {
    const j = pkg.jest;
    j.transform = j.transform || {};
    const KEY = '^.+\\.[jt]sx?$';
    const VAL = 'babel-jest';
    if (j.transform[KEY] !== VAL) {
      j.transform[KEY] = VAL;
      writeJSON(PKG_PATH, pkg);
      log('Updated package.json: set jest.transform → babel-jest');
    } else {
      log('package.json jest.transform already uses babel-jest');
    }
    return;
  }

  // B) jest.config.(js|cjs)
  const cfgPath = JEST_FILES.find(exists);
  if (cfgPath) {
    let src = fs.readFileSync(cfgPath, 'utf8');

    // If file already mentions babel-jest, we’re done
    if (/['"]babel-jest['"]/.test(src)) {
      log(`${path.basename(cfgPath)} already references babel-jest`);
      return;
    }

    // Try to inject into "module.exports = { ... }"
    const objectHeader = /module\.exports\s*=\s*\{/m;
    if (objectHeader.test(src)) {
      const transformRegex = /transform\s*:\s*\{([\s\S]*?)\}/m;
      if (transformRegex.test(src)) {
        // Add our mapping if not present
        src = src.replace(transformRegex, (m, inner) => {
          if (/['"]\^\.\\\+\[jt]sx\?\$['"]\s*:\s*['"]babel-jest['"]/.test(inner)) return m;
          const trimmed = inner.trim();
          const needsComma = trimmed && !trimmed.endsWith(',');
          const insertion = (needsComma ? inner + ' ' : inner) + `'^^': '^^'`; // placeholder
          const replaced = `transform: {${insertion}}`;
          // Now swap placeholder with the real mapping (easier escaping)
          return replaced.replace("'^^': '^^'", `'${'^.+\\\\.[jt]sx?$'}': 'babel-jest',`);
        });
      } else {
        // Add a whole transform field after the opening brace
        src = src.replace(objectHeader, match => {
          return `${match}
  transform: { '^.+\\\\.[jt]sx?$': 'babel-jest' },`;
        });
      }
      writeIfChanged(cfgPath, src);
      log(`Updated ${path.basename(cfgPath)}: ensured babel-jest transform`);
      return;
    }

    // ESM/TS configs (mjs/ts) or unusual shapes: don’t auto-edit, just guide
    log(`Found ${path.basename(cfgPath)} but could not safely edit; please ensure transform uses babel-jest.`);
    return;
  }

  // C) No Jest config found — create minimal one
  const newCfg = path.join(ROOT, 'jest.config.js');
  const content =
`/** Auto-generated by js-sanitizer setup */
module.exports = {
  testEnvironment: 'node',
  transform: { '^.+\\\\.[jt]sx?$': 'babel-jest' }
};`;
  writeIfChanged(newCfg, content);
  log('Created jest.config.js using babel-jest transform');
})();

// ----------------- 3) Mocha wiring (@babel/register) -----------------
(function ensureMocha() {
  if (!hasAnyDep('mocha')) {
    log('Mocha not detected — skipping Mocha wiring.');
    return;
  }

  const regContent =
`// Auto-generated by js-sanitizer setup
try {
  require('@babel/register')({
    extensions: ['.js', '.jsx', '.ts', '.tsx'],
    cache: true
  });
} catch (e) {
  // eslint-disable-next-line no-console
  console.warn('[js-sanitizer] Mocha: @babel/register not found. Install it with: npm i -D @babel/register');
}`;
  writeIfChanged(BABEL_REGISTER, regContent);

  let mocharc = exists(MOCHA_RC) ? readJSON(MOCHA_RC) : {};
  const req = new Set(ensureArray(mocharc.require));
  req.add('./babel.register.js');
  mocharc.require = Array.from(req);
  writeJSON(MOCHA_RC, mocharc);
  log('Ensured .mocharc.json requires ./babel.register.js (Babel active for Mocha).');

  if (!hasAnyDep('@babel/register')) {
    log('WARNING: @babel/register not found. Install it for Mocha/Vitest runtime Babel: npm i -D @babel/register');
  }
})();

// ----------------- 4) Vitest wiring (@babel/register) -----------------
(function ensureVitest() {
  if (!hasAnyDep('vitest')) {
    log('Vitest not detected — skipping Vitest wiring.');
    return;
  }

  const setupContent =
`// Auto-generated by js-sanitizer setup
try {
  require('@babel/register')({
    extensions: ['.js', '.jsx', '.ts', '.tsx'],
    cache: true
  });
} catch (e) {
  // eslint-disable-next-line no-console
  console.warn('[js-sanitizer] Vitest: @babel/register not found. Install it with: npm i -D @babel/register');
}`;
  writeIfChanged(VITEST_SETUP, setupContent);

  const vitestCfg = pkg.vitest || {};
  const setupFiles = new Set(ensureArray(vitestCfg.setupFiles));
  setupFiles.add('./vitest.setup.js');
  vitestCfg.setupFiles = Array.from(setupFiles);
  pkg.vitest = vitestCfg;
  writeJSON(PKG_PATH, pkg);
  log('Added ./vitest.setup.js to package.json → vitest.setupFiles');

  if (!hasAnyDep('@babel/register')) {
    log('WARNING: @babel/register not found. Install it for Mocha/Vitest runtime Babel: npm i -D @babel/register');
  }
})();

// ----------------- 5) Final dependency hints -----------------
(function finalHints() {
  if (!hasAnyDep('@babel/core')) {
    log('WARNING: @babel/core not detected. Install it: npm i -D @babel/core @babel/preset-env');
  } else {
    log('@babel/core detected.');
  }
  log('Setup complete.');
})();
