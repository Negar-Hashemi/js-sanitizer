#!/usr/bin/env node
/* setup.js for js-sanitizer
 * - Adds "module:js-sanitizer" to Babel config (no duplicates)
 * - Jest: ensures babel-jest transform if babel-jest is installed; else warns
 * - Mocha: creates/updates .mocharc.json to require Babel; adds babel.register.js
 * - Vitest: creates vitest.setup.js to register Babel; adds "vitest.setup.js" in package.json->vitest.setupFiles
 * Safe, idempotent, and will not break existing configs.
 */
const fs = require('fs');
const path = require('path');

const PLUGIN_NAME = 'module:js-sanitizer';
const CONFIG_FILES = ['babel.config.js', '.babelrc', '.babelrc.json'];
const PKG_PATH = path.resolve(process.cwd(), 'package.json');

if (process.env.JS_SANITIZER_SKIP_SETUP === '1') {
  log('[setup] Skipped due to JS_SANITIZER_SKIP_SETUP=1');
  process.exit(0);
}

// ---- Utilities ----
function log(msg) {
  console.log(`[js-sanitizer] ${msg}`);
}
function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}
function fileExists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}
function findConfigPath() {
  for (const f of CONFIG_FILES) {
    const p = path.resolve(process.cwd(), f);
    if (fileExists(p)) return p;
  }
  return null;
}
function ensureArray(x) {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}
function hasDep(pkg, name) {
  return Boolean(
    pkg?.dependencies?.[name] ||
    pkg?.devDependencies?.[name] ||
    pkg?.peerDependencies?.[name]
  );
}
function writeIfDifferent(p, content) {
  const newContent = typeof content === 'string' ? content : String(content);
  if (fileExists(p)) {
    const old = fs.readFileSync(p, 'utf8');
    if (old === newContent) return false;
  }
  fs.writeFileSync(p, newContent);
  return true;
}

// ---- Step 1: Read package.json ----
const pkg = readJson(PKG_PATH) || {};
if (!pkg.name) log('package.json found.');

// ---- Step 2: Ensure Babel config contains the plugin ----
function updateJsonBabelConfig(p) {
  const cfg = readJson(p) || {};
  cfg.plugins = ensureArray(cfg.plugins);
  if (!cfg.plugins.includes(PLUGIN_NAME)) {
    cfg.plugins.push(PLUGIN_NAME);
    writeJson(p, cfg);
    log(`Added ${PLUGIN_NAME} to ${path.basename(p)}`);
  } else {
    log(`Plugin already present in ${path.basename(p)}`);
  }
}

function updateJsBabelConfig(p) {
  let src = fs.readFileSync(p, 'utf8');

  if (src.includes(PLUGIN_NAME)) {
    log(`Plugin already present in ${path.basename(p)}`);
    return;
  }

  // Try to insert into existing plugins: [ ... ]
  const pluginsArrayRegex = /plugins\s*:\s*\[([\s\S]*?)\]/m;
  if (pluginsArrayRegex.test(src)) {
    src = src.replace(pluginsArrayRegex, (m, inner) => {
      const trimmed = inner.trim();
      const needsComma = trimmed.length && !trimmed.trim().endsWith(',');
      const insertion = (needsComma ? inner + ', ' : inner + ' ') + `'${PLUGIN_NAME}'`;
      return `plugins: [${insertion}]`;
    });
  } else {
    // Insert new plugins array after module.exports = {
    src = src.replace(/module\.exports\s*=\s*\{/, match => {
      return `${match}\n  plugins: ['${PLUGIN_NAME}'],`;
    });
  }

  writeIfDifferent(p, src);
  log(`Added ${PLUGIN_NAME} to ${path.basename(p)}`);
}

function createMinimalBabelConfig() {
  const p = path.resolve(process.cwd(), 'babel.config.js');
  if (fileExists(p)) return updateJsBabelConfig(p);
  const content =
`module.exports = {
  presets: [
    ["@babel/preset-env", { targets: { node: "current" } }]
  ],
  plugins: ['${PLUGIN_NAME}'],
  comments: true
};
`;
  fs.writeFileSync(p, content);
  log(`Created babel.config.js with ${PLUGIN_NAME}`);
}

(function ensureBabelPlugin() {
  const configPath = findConfigPath();
  if (!configPath) {
    createMinimalBabelConfig();
  } else if (configPath.endsWith('.json') || configPath.endsWith('.babelrc')) {
    updateJsonBabelConfig(configPath);
  } else {
    updateJsBabelConfig(configPath); // babel.config.js
  }
})();

// ---- Step 3: Framework-specific helpers ----
const hasJest   = hasDep(pkg, 'jest');
const hasVitest = hasDep(pkg, 'vitest');
const hasMocha  = hasDep(pkg, 'mocha');

if (!hasJest && !hasVitest && !hasMocha) {
  log('No Jest/Vitest/Mocha detected. Setup for Babel is complete.');
}

// 3a) JEST: ensure transform uses babel-jest if present
(function ensureJest() {
  if (!hasJest) return;

  const hasBabelJest = hasDep(pkg, 'babel-jest');
  const jestConfigFiles = ['jest.config.js', 'jest.config.cjs', 'jest.config.mjs', 'jest.config.ts']
    .map(f => path.resolve(process.cwd(), f));
  const pkgHasJestConfig = !!pkg.jest;

  // Attempt to modify package.json jest config if present & simple
  if (pkgHasJestConfig) {
    const j = pkg.jest;
    if (!j.transform && hasBabelJest) {
      j.transform = { '^.+\\.[jt]sx?$': 'babel-jest' };
      writeJson(PKG_PATH, pkg);
      log('Updated package.json: added jest.transform -> babel-jest');
    } else if (!hasBabelJest) {
      log('Jest found but babel-jest is not installed. Install it to enable Babel: npm i -D babel-jest');
    } else {
      log('Jest config already present; leaving as-is.');
    }
    return;
  }

  // If a jest.config.* file exists, do not mutate it (too many formats). Just warn/help.
  const foundJestConfig = jestConfigFiles.find(fileExists);
  if (foundJestConfig) {
    if (!hasBabelJest) {
      log(`Jest config detected (${path.basename(foundJestConfig)}). Install babel-jest and ensure it is used as transformer.`);
    } else {
      log(`Jest config detected (${path.basename(foundJestConfig)}). Ensure transform includes: { '^.+\\\\.[jt]sx?$': 'babel-jest' }`);
    }
    return;
  }

  // If nothing found and babel-jest is installed, create a minimal jest.config.js
  if (hasBabelJest) {
    const jestCfgPath = path.resolve(process.cwd(), 'jest.config.js');
    const content =
`/** Auto-generated by js-sanitizer setup */
module.exports = {
  testEnvironment: 'node',
  transform: { '^.+\\\\.[jt]sx?$': 'babel-jest' }
};`;
    writeIfDifferent(jestCfgPath, content);
    log('Created jest.config.js using babel-jest transform.');
  } else {
    log('Jest detected. Consider installing babel-jest to ensure Babel plugins run: npm i -D babel-jest');
  }
})();

// 3b) MOCHA: create .mocharc.json to require Babel register & a small register file
(function ensureMocha() {
  if (!hasMocha) return;

  // Create a tiny babel register file (so we control cwd & cache)
  const regPath = path.resolve(process.cwd(), 'babel.register.js');
  const regContent =
`// Auto-generated by js-sanitizer setup
require('@babel/register')({
  // Use your babel.config.js/.babelrc; no need to list plugins here
  extensions: ['.js', '.jsx', '.ts', '.tsx'],
  cache: true
});`;
  writeIfDifferent(regPath, regContent);

  // Create/update .mocharc.json to require the register file
  const mocharcPath = path.resolve(process.cwd(), '.mocharc.json');
  let mocharc = fileExists(mocharcPath) ? readJson(mocharcPath) : {};
  const req = new Set(ensureArray(mocharc.require));
  req.add('./babel.register.js');
  mocharc.require = Array.from(req);
  writeJson(mocharcPath, mocharc);
  log('Ensured .mocharc.json requires ./babel.register.js (Babel active for Mocha).');
})();

// 3c) VITEST: add a setup file that registers Babel at runtime, and register it in package.json
(function ensureVitest() {
  if (!hasVitest) return;

  const setupPath = path.resolve(process.cwd(), 'vitest.setup.js');
  const setupContent =
`// Auto-generated by js-sanitizer setup
// Register Babel so js-sanitizer runs during Vitest
try {
  require('@babel/register')({
    extensions: ['.js', '.jsx', '.ts', '.tsx'],
    cache: true
  });
} catch (e) {
  // If @babel/register is missing, advise via console
  // eslint-disable-next-line no-console
  console.warn('[js-sanitizer] Vitest: @babel/register not found. Install it with: npm i -D @babel/register');
}`;
  writeIfDifferent(setupPath, setupContent);

  // Add to package.json under "vitest": { "setupFiles": [...] }
  const vcfg = pkg.vitest || {};
  const setupFiles = new Set(ensureArray(vcfg.setupFiles));
  setupFiles.add('./vitest.setup.js');
  vcfg.setupFiles = Array.from(setupFiles);
  pkg.vitest = vcfg;
  writeJson(PKG_PATH, pkg);
  log('Added ./vitest.setup.js to package.json -> vitest.setupFiles.');

  // Gentle nudge about Vite-level Babel if user prefers:
  log('Note: For Vite-integrated Babel instead of @babel/register, configure a Vite Babel plugin in vite/vitest config.');
})();

// ---- Final notes ----
(function sanityChecks() {
  const hasBabelCore = hasDep(pkg, '@babel/core');
  if (!hasBabelCore) {
    log('WARNING: @babel/core not detected. Install it for the plugin to run: npm i -D @babel/core @babel/preset-env');
  } else {
    log('@babel/core detected.');
  }
  log('Setup complete.');
})();
