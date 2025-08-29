#!/usr/bin/env node
/**
 * js-sanitizer setup (Jest + Mocha + Vitest)
 * - Operates in consumer project (prefers npm_config_local_prefix / INIT_CWD)
 * - Ensures Babel config exists, includes plugin, and keeps ESM (modules:false)
 * - Wires Jest (babel-jest), Mocha (@babel/register), Vitest (vite-plugin-babel)
 * - Idempotent, conservative edits; clear warnings
 * - Optional auto-install of missing devDeps when JS_SANITIZER_AUTO_INSTALL=1
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = (() => {
  // Prefer workspace signals first (robust even when the dep is hoisted)
  const localPrefix = process.env.npm_config_local_prefix;
  if (localPrefix && fs.existsSync(path.join(localPrefix, 'package.json'))) {
    return localPrefix;
  }
  if (process.env.INIT_CWD && fs.existsSync(path.join(process.env.INIT_CWD, 'package.json'))) {
    return process.env.INIT_CWD;
  }
  // Fallback: if installed under <consumer>/node_modules/js-sanitizer, twoUp is the consumer
  const twoUp = path.resolve(__dirname, '..', '..');
  if (fs.existsSync(path.join(twoUp, 'package.json')) && !/node_modules[\\/]/.test(twoUp)) {
    return twoUp;
  }
  return process.cwd();
})();

const PKG_PATH = path.join(ROOT, 'package.json');
const PLUGIN_NAME = 'module:js-sanitizer';

const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
const read   = (p) => fs.readFileSync(p, 'utf8');
const readJSON = (p) => { try { return JSON.parse(read(p)); } catch { return null; } };
const writeJSON = (p, o) => fs.writeFileSync(p, JSON.stringify(o, null, 2) + '\n');
const writeIfChanged = (p, s) => {
  const str = String(s);
  if (exists(p) && read(p) === str) return false;
  fs.writeFileSync(p, str);
  return true;
};

// ---- safe package.json updater (prevents stale overwrite) ----
function updatePkg(mutator) {
  const before = readJSON(PKG_PATH) || {};
  const copy = JSON.parse(JSON.stringify(before));
  const out = mutator(copy) || copy;
  const changed = JSON.stringify(out) !== JSON.stringify(before);
  if (changed) writeJSON(PKG_PATH, out);
  return changed;
}

function ensureDevDepInPkg(name, version = '*') {
  return updatePkg((p) => {
    p.devDependencies = p.devDependencies || {};
    if (!p.devDependencies[name] && !p.dependencies?.[name] && !p.peerDependencies?.[name]) {
      p.devDependencies[name] = version;
      log(`Added ${name}@${version} to package.json devDependencies`);
    }
    return p;
  });
}

function hasAnyDep(name) {
  const p = readJSON(PKG_PATH) || {};
  return !!(p.dependencies?.[name] || p.devDependencies?.[name] || p.peerDependencies?.[name]);
}

const ensureArray = (x) => (Array.isArray(x) ? x : (x == null ? [] : [x]));
const log = (m) => console.log(`[js-sanitizer setup] ${m}`);

const PM = (() => {
  const ua = process.env.npm_config_user_agent || '';
  if (ua.startsWith('pnpm')) return 'pnpm';
  if (ua.startsWith('yarn')) return 'yarn';
  if (ua.startsWith('bun'))  return 'bun';
  return 'npm';
})();

function installArgs(pkgs, dev = true) {
  const list = Array.isArray(pkgs) ? pkgs : [pkgs];
  switch (PM) {
    case 'pnpm': return ['add', dev ? '-D' : '-P', ...list];
    case 'yarn': return ['add', dev ? '-D' : '', ...list].filter(Boolean);
    case 'bun':  return ['add', dev ? '-d' : '', ...list].filter(Boolean);
    default:     return ['i', dev ? '-D' : '', ...list].filter(Boolean);
  }
}

function tryInstall(pkgs, dev = true) {
  if (process.env.JS_SANITIZER_AUTO_INSTALL !== '1') return false;
  const args = installArgs(pkgs, dev);
  try {
    log(`Auto-installing (${PM}) → ${[PM, ...args].join(' ')}`);
    cp.execSync([PM, ...args].join(' '), { stdio: 'inherit', cwd: ROOT, env: process.env });
    return true;
  } catch {
    log(`WARNING: Failed to install ${[].concat(pkgs).join(', ')} with ${PM}. You can install manually.`);
    return false;
  }
}

if (process.env.JS_SANITIZER_SKIP_SETUP === '1') {
  log('Skipping due to JS_SANITIZER_SKIP_SETUP=1');
  process.exit(0);
}

// initial snapshot (used for non-destructive reads only)
const pkg = readJSON(PKG_PATH) || {};
const isESMProject = pkg.type === 'module';
const hasDep = (name) => !!(pkg.dependencies?.[name] || pkg.devDependencies?.[name] || pkg.peerDependencies?.[name]);

log(`Using project root: ${ROOT}`);

/* ----------------------------------------
 * 1) Ensure Babel config + modules:false (+ TS when present)
 * --------------------------------------*/
(function ensureBabelConfig() {
  // Prefer .cjs in ESM projects when using CommonJS export to avoid "module is not defined"
  const targetBabelFile = isESMProject ? 'babel.config.cjs' : 'babel.config.js';
  const targetPath = path.join(ROOT, targetBabelFile);

  // If ESM project has babel.config.js with CJS export, rename to .cjs
  const jsPath = path.join(ROOT, 'babel.config.js');
  if (isESMProject && exists(jsPath)) {
    const src = read(jsPath);
    if (/module\.exports\s*=/.test(src)) {
      const cjsPath = path.join(ROOT, 'babel.config.cjs');
      if (!exists(cjsPath)) {
        fs.renameSync(jsPath, cjsPath);
        log('Renamed babel.config.js → babel.config.cjs for ESM compatibility');
      }
    }
  }

  // Helper: add plugin name into a JSON-style babel config object safely
  const addPluginToJSONCfg = (cfg) => {
    const arr = Array.isArray(cfg.plugins) ? cfg.plugins.slice() : [];
    if (!arr.includes(PLUGIN_NAME)) arr.push(PLUGIN_NAME);
    cfg.plugins = arr;
    return cfg;
  };

  // Helper: ensure preset exists in JSON cfg
  const ensurePresetInJSONCfg = (cfg, presetName, presetConfig) => {
    cfg.presets = Array.isArray(cfg.presets) ? cfg.presets.slice() : [];
    const hasPreset = cfg.presets.some(p => {
      if (typeof p === 'string') return p === presetName;
      if (Array.isArray(p)) return p[0] === presetName;
      return false;
    });
    if (!hasPreset) cfg.presets.unshift([presetName, presetConfig]);
    return cfg;
  };

  const typescriptPresent = hasAnyDep('typescript');

  // 1) JSON-based configs (do not disturb existing presets/options)
  const jsonPaths = ['.babelrc', '.babelrc.json'].map(f => path.join(ROOT, f));
  for (const p of jsonPaths) {
    if (!exists(p)) continue;
    let cfg = readJSON(p) || {};
    cfg = ensurePresetInJSONCfg(cfg, '@babel/preset-env', { targets: { node: 'current' }, modules: false });
    if (typescriptPresent) {
      cfg = ensurePresetInJSONCfg(cfg, '@babel/preset-typescript', { allowDeclareFields: true });
    }
    cfg = addPluginToJSONCfg(cfg);
    writeJSON(p, cfg);
    log(`Updated ${path.basename(p)}: ensured presets and ${PLUGIN_NAME}`);
    return;
  }

  // 2) Code-based config present → edit conservatively
  if (exists(targetPath)) {
    let src = read(targetPath);
    let changed = false;

    // --- Inject ONLY into env.commonjs.plugins if present (Jest path) ---
    (function injectIntoCommonjsEnv() {
      let localChanged = false;

      function appendIntoPluginsBlock(source, blockLabelRegex) {
        return source.replace(blockLabelRegex, (whole, head, body) => {
          const pluginsRx = /plugins\s*:\s*\[([\s\S]*?)\]/m;
          if (pluginsRx.test(body)) {
            body = body.replace(pluginsRx, (m, inner) => {
              if (inner.includes(`'${PLUGIN_NAME}'`) || inner.includes(`"${PLUGIN_NAME}"`)) {
                return m; // already present
              }
              const trimmed = inner.trim();
              const hasTrailingComma = /,\s*$/.test(inner);
              const innerNoTrailWS = inner.replace(/\s*$/, '');
              const sep = trimmed ? (hasTrailingComma ? ' ' : ', ') : '';
              localChanged = true;
              return `plugins: [${innerNoTrailWS}${sep}'${PLUGIN_NAME}']`;
            });
          } else {
            localChanged = true;
            body = body.replace(/^\s*/, match => `${match}plugins: ['${PLUGIN_NAME}'],\n`);
          }
          return `${head}${body}}`;
        });
      }

      const envCommonjs = /(\bcommonjs\s*:\s*\{\s*)([\s\S]*?)\}/m;
      if (envCommonjs.test(src)) {
        src = appendIntoPluginsBlock(src, envCommonjs);
      }

      if (localChanged) changed = true;
    })();

    // 2a) Ensure top-level plugins contains our plugin (fallback)
    if (!src.includes(PLUGIN_NAME)) {
      const pluginsArrayRegex = /plugins\s*:\s*\[([\s\S]*?)\]/m;
      if (pluginsArrayRegex.test(src)) {
        src = src.replace(pluginsArrayRegex, (m, inner) => {
          if (inner.includes(`'${PLUGIN_NAME}'`) || inner.includes(`"${PLUGIN_NAME}"`)) return m;
          const trimmed = inner.trim();
          const hasTrailingComma = /,\s*$/.test(inner);
          const innerNoTrailWS = inner.replace(/\s*$/, '');
          const sep = trimmed ? (hasTrailingComma ? ' ' : ', ') : '';
          return `plugins: [${innerNoTrailWS}${sep}'${PLUGIN_NAME}']`;
        });
        changed = true;
      } else {
        let inserted = false;
        src = src.replace(/return\s*\{\s*/m, (mm) => {
          inserted = true;
          return `${mm}\n  plugins: ['${PLUGIN_NAME}'],`;
        });
        if (!inserted) {
          src = src.replace(/module\.exports\s*=\s*\{\s*/m, (mm) => {
            return `${mm}\n  plugins: ['${PLUGIN_NAME}'],`;
          });
        }
        changed = true;
      }
    }

    // 2b) Ensure @babel/preset-env exists
    if (!/['"]@babel\/preset-env['"]/.test(src)) {
      const presetsRegex = /presets\s*:\s*\[/m;
      if (presetsRegex.test(src)) {
        src = src.replace(
          presetsRegex,
          `presets: [["@babel/preset-env", { targets: { node: "current" }, modules: false }], `
        );
      } else {
        let inserted = false;
        src = src.replace(/return\s*\{\s*/m, (mm) => {
          inserted = true;
          return `${mm}
  presets: [["@babel/preset-env", { targets: { node: "current" }, modules: false }]],`;
        });
        if (!inserted) {
          src = src.replace(/module\.exports\s*=\s*\{\s*/m, (mm) => {
            return `${mm}
  presets: [["@babel/preset-env", { targets: { node: "current" }, modules: false }]],`;
          });
        }
      }
      changed = true;
    }

    // 2c) If TypeScript is present, ensure @babel/preset-typescript exists
    if (typescriptPresent && !/['"]@babel\/preset-typescript['"]/.test(src)) {
      const presetsArrayRegex = /presets\s*:\s*\[([\s\S]*?)\]/m;
      if (presetsArrayRegex.test(src)) {
        src = src.replace(presetsArrayRegex, (m, inner) => {
          if (inner.includes(`'@babel/preset-typescript'`) || inner.includes(`"@babel/preset-typescript"`)) return m;
          const trimmed = inner.trim();
          const hasTrailingComma = /,\s*$/.test(inner);
          const innerNoTrailWS = inner.replace(/\s*$/, '');
          const sep = trimmed ? (hasTrailingComma ? ' ' : ', ') : '';
          return `presets: [${innerNoTrailWS}${sep}["@babel/preset-typescript", { allowDeclareFields: true }]]`;
        });
      } else {
        let inserted = false;
        src = src.replace(/return\s*\{\s*/m, (mm) => {
          inserted = true;
          return `${mm}
  presets: [
    ["@babel/preset-env", { targets: { node: "current" }, modules: false }],
    ["@babel/preset-typescript", { allowDeclareFields: true }]
  ],`;
        });
        if (!inserted) {
          src = src.replace(/module\.exports\s*=\s*\{\s*/m, (mm) => {
            return `${mm}
  presets: [
    ["@babel/preset-env", { targets: { node: "current" }, modules: false }],
    ["@babel/preset-typescript", { allowDeclareFields: true }]
  ],`;
          });
        }
      }
      changed = true;
    }

    if (changed) {
      writeIfChanged(targetPath, src);
      log(`Updated ${path.basename(targetPath)}: ensured presets/plugins (incl. TS when present).`);
    } else {
      log(`${path.basename(targetPath)} already contains required presets/plugins.`);
    }
    return;
  }

  // 3) No config found → create a minimal one (include TS preset if TS present)
  const typescriptPresentMinimal = hasAnyDep('typescript');
  const minimal =
`module.exports = {
  presets: [
    ["@babel/preset-env", { targets: { node: "current" }, modules: false }]${
      typescriptPresentMinimal ? `,
    ["@babel/preset-typescript", { allowDeclareFields: true }]` : ''
    }
  ],
  plugins: ['${PLUGIN_NAME}'],
  comments: true
};
`;
  fs.writeFileSync(targetPath, minimal);
  log(`Created ${path.basename(targetPath)} (minimal, includes ${PLUGIN_NAME}${typescriptPresentMinimal ? ' + preset-typescript' : ''}).`);
})();


/* ----------------------------------------
 * 2) Jest wiring (ts-jest + Babel or babel-jest fallback)
 * --------------------------------------*/
(function ensureJest() {
  const freshPkg = readJSON(PKG_PATH) || {};
  const scriptsTest = String(freshPkg.scripts?.test || '');
  const jestReferenced = hasAnyDep('jest') || /(^|[\s;(&|])jest(\s|$)/.test(scriptsTest);
  if (!jestReferenced) {
    log('Jest not detected (dependency or scripts.test) — skipping Jest wiring.');
    return;
  }

  const hasTsJest = hasAnyDep('ts-jest');
  const usesTS = hasAnyDep('typescript') || hasTsJest || hasAnyDep('@types/jest');

  if (!hasAnyDep('@babel/core')) {
    log('Missing @babel/core for Jest/Babel.');
    tryInstall(['@babel/core'], true);
  }
  if (!hasAnyDep('@babel/preset-env')) {
    tryInstall(['@babel/preset-env'], true);
  }
  if (usesTS && !hasAnyDep('@babel/preset-typescript')) {
    tryInstall(['@babel/preset-typescript'], true);
  }
  if (!hasAnyDep('jest-docblock')) {
    tryInstall(['jest-docblock'], true);
  }

  const pkgHasInlineJest = !!freshPkg.jest && typeof freshPkg.jest === 'object';

  if (pkgHasInlineJest && freshPkg.globals && freshPkg.globals['ts-jest']) {
    updatePkg((p) => {
      p.jest = p.jest || {};
      p.jest.globals = p.jest.globals || {};
      const fromTop = p.globals && p.globals['ts-jest'] || {};
      const current = p.jest.globals['ts-jest'] || {};
      p.jest.globals['ts-jest'] = Object.assign({}, current, fromTop, { babelConfig: true });
      if (p.globals) {
        delete p.globals['ts-jest'];
        if (Object.keys(p.globals).length === 0) delete p.globals;
      }
      return p;
    });
    log('Moved top-level globals.ts-jest → jest.globals["ts-jest"] with babelConfig:true');
  }

  const JEST_FILES = ['jest.config.js', 'jest.config.cjs'].map(f => path.join(ROOT, f));
  const jestCfgPath = JEST_FILES.find(exists);

  if (pkgHasInlineJest) {
    updatePkg((p) => {
      p.jest = p.jest || {};
      if (hasTsJest) {
        p.jest.transform = p.jest.transform || {};
        const tsKey = '^.+\\.ts$';
        if (!p.jest.transform[tsKey]) {
          p.jest.transform[tsKey] = 'ts-jest';
        }
        p.jest.globals = p.jest.globals || {};
        const cur = p.jest.globals['ts-jest'] || {};
        p.jest.globals['ts-jest'] = Object.assign({}, cur, { babelConfig: true });
        log('Enabled ts-jest → Babel pass via package.json jest.globals["ts-jest"].babelConfig');
      } else {
        p.jest.transform = p.jest.transform || {};
        const KEY = '^.+\\.[jt]sx?$';
        if (p.jest.transform[KEY] !== 'babel-jest') {
          p.jest.transform[KEY] = 'babel-jest';
          log('Set package.json jest.transform → babel-jest for JS/TS files');
        }
        if (!hasAnyDep('babel-jest')) {
          tryInstall(['babel-jest'], true);
        }
      }
      return p;
    });
    return;
  }

  if (jestCfgPath) {
    const src = read(jestCfgPath);
    if (/Auto-generated by js-sanitizer setup/.test(src)) {
      let out = src;
      if (hasTsJest) {
        out = out.replace(
          /transform:\s*\{[^}]*\}/m,
          `transform: { '^.+\\\\.ts$': 'ts-jest' },\n  globals: { 'ts-jest': { babelConfig: true } }`
        );
      } else {
        if (!hasAnyDep('babel-jest')) tryInstall(['babel-jest'], true);
      }
      writeIfChanged(jestCfgPath, out);
      log(`Updated ${path.basename(jestCfgPath)} for ${hasTsJest ? 'ts-jest + Babel' : 'babel-jest'}`);
    } else {
      log(`${path.basename(jestCfgPath)} present; not modifying user config. Make sure it enables Babel (ts-jest babelConfig or babel-jest).`);
    }
    return;
  }

  const newCfg = hasTsJest
    ? `/** Auto-generated by js-sanitizer setup */
module.exports = {
  testEnvironment: 'node',
  transform: { '^.+\\\\.ts$': 'ts-jest' },
  globals: { 'ts-jest': { babelConfig: true } }
};
`
    : `/** Auto-generated by js-sanitizer setup */
module.exports = {
  testEnvironment: 'node',
  transform: { '^.+\\\\.[jt]sx?$': 'babel-jest' }
};
`;

  writeIfChanged(path.join(ROOT, 'jest.config.js'), newCfg);
  log(`Created jest.config.js for ${hasTsJest ? 'ts-jest (with Babel pass)' : 'babel-jest'}`);
})();

/* ----------------------------------------
 * 3) Mocha wiring (@babel/register) — CJS-safe + migration
 * --------------------------------------*/
(function ensureMocha() {
  if (!hasAnyDep('mocha')) {
    log('Mocha not detected — skipping Mocha wiring.');
    return;
  }

  // Make sure we have the small bits we rely on
  if (!hasAnyDep('jest-docblock')) {
    tryInstall(['jest-docblock'], true);
  }

  if (!hasAnyDep('@babel/register')) {
    log('Missing @babel/register for Mocha.');
    tryInstall(['@babel/register'], true);
    if (!hasAnyDep('@babel/register')) {
      log('WARNING: @babel/register not found. Install: npm i -D @babel/register');
    }
  }

  // Always use a CJS file so "require(...)" works even in ESM repos
  const BABEL_REGISTER_CJS = path.join(ROOT, 'babel.register.cjs');
  const LEGACY_REGISTER_JS = path.join(ROOT, 'babel.register.js');

  // If old JS register exists and CJS doesn't, migrate it
  if (exists(LEGACY_REGISTER_JS) && !exists(BABEL_REGISTER_CJS)) {
    try {
      fs.renameSync(LEGACY_REGISTER_JS, BABEL_REGISTER_CJS);
      log('Renamed babel.register.js → babel.register.cjs for ESM compatibility');
    } catch (e) {
      // If rename fails for any reason, we will overwrite/write the CJS file below.
    }
  }

  const regContentCJS =
`// Auto-generated by js-sanitizer setup (CJS-safe)
try {
  require('@babel/register')({
    extensions: ['.js', '.jsx', '.ts', '.tsx', '.cjs', '.mjs'],
    cache: true,
    babelrc: true,
    configFile: true,
    // Avoid double-injecting the sanitizer plugin: only add if not present in babel config
    plugins: (function () {
      try {
        let cfg = null;
        try { cfg = require('./babel.config.cjs'); } catch {}
        if (!cfg) { try { cfg = require('./babel.config.js'); } catch {} }
        const list = (cfg && cfg.plugins) || [];
        const has = Array.isArray(list) && list.some(p =>
          (typeof p === 'string' && p === '${PLUGIN_NAME}') ||
          (Array.isArray(p) && p[0] === '${PLUGIN_NAME}')
        );
        return has ? [] : ['${PLUGIN_NAME}'];
      } catch {
        return ['${PLUGIN_NAME}'];
      }
    })()
  });
} catch (e) {
  console.warn('[js-sanitizer] Mocha: @babel/register not found or failed. Install with: npm i -D @babel/register');
  console.log('[js-sanitizer]:'+ e)
}
`;
  writeIfChanged(BABEL_REGISTER_CJS, regContentCJS);

  // Detect Mocha major version (best-effort; only used to decide mocharc vs mocha.opts)
  let mochaMajor = null;
  try {
    const pjson = readJSON(PKG_PATH) || {};
    const ver = (pjson.devDependencies && pjson.devDependencies.mocha)
             || (pjson.dependencies && pjson.dependencies.mocha)
             || '';
    const m = String(ver).match(/\d+/);
    mochaMajor = m ? parseInt(m[0], 10) : null;
  } catch {}

  // Prefer .mocharc.json for Mocha >= 6; otherwise fall back to mocha.opts
  if (mochaMajor && mochaMajor >= 6) {
    const MOCHA_RC = path.join(ROOT, '.mocharc.json');
    let mocharc = exists(MOCHA_RC) ? readJSON(MOCHA_RC) : {};
    const req = new Set(ensureArray(mocharc.require));
    // Remove old .js reference if present; prefer .cjs
    req.delete('./babel.register.js');
    req.add('./babel.register.cjs');
    mocharc.require = Array.from(req);
    writeJSON(MOCHA_RC, mocharc);
    log('Ensured .mocharc.json requires ./babel.register.cjs (Mocha ≥6).');
  } else {
    // Legacy Mocha (<6): use mocha.opts
    const testDir = exists(path.join(ROOT, 'test')) ? path.join(ROOT, 'test') : ROOT;
    const OPTS = path.join(testDir, 'mocha.opts');
    let content = exists(OPTS) ? read(OPTS) : '';

    // Remove any line requiring the old .js file
    content = content.replace(/^-{1,2}require\s+\.\/babel\.register\.js\s*$/m, '').trimEnd();

    // Ensure a trailing newline
    if (content && !content.endsWith('\n')) content += '\n';

    // Add the .cjs require if not present
    if (!/^-{1,2}require\s+\.\/babel\.register\.cjs\s*$/m.test(content)) {
      content += `--require ./babel.register.cjs\n`;
      writeIfChanged(OPTS, content);
      log(`Ensured "--require ./babel.register.cjs" in ${path.relative(ROOT, OPTS)} (Mocha <6).`);
    } else {
      writeIfChanged(OPTS, content); // in case we removed old .js line above
      log(`mocha.opts already requires ./babel.register.cjs (Mocha <6).`);
    }
  }
})();


/* ----------------------------------------
 * Vitest wiring (only if Vitest is actually used)
 * --------------------------------------*/
(function ensureVitest() {
  // Opt-out (useful for Mocha-only repos)
  if (process.env.JS_SANITIZER_SKIP_VITEST === '1') {
    log('Vitest wiring skipped (JS_SANITIZER_SKIP_VITEST=1).');
    return;
  }

  const fresh = readJSON(PKG_PATH) || {};
  const scriptsTest = String(fresh.scripts?.test || '');

  // Detect Vitest usage
  const vitestInDeps = hasAnyDep('vitest');
  const vitestReferenced = vitestInDeps || /\bvitest\b/.test(scriptsTest);

  // Only proceed if Vitest is detected or explicitly forced
  if (!vitestReferenced && process.env.JS_SANITIZER_VITEST_ALWAYS !== '1') {
    log('Vitest not detected — skipping Vitest wiring.');
    return;
  }

  // From here on, Vitest is in use (or forced) → ensure setupFiles
  updatePkg((p) => {
    p.vitest = p.vitest || {};
    const s = new Set(ensureArray(p.vitest.setupFiles));
    s.add('./vitest.setup.js');
    p.vitest.setupFiles = Array.from(s);
    return p;
  });

  const setupPath = path.join(ROOT, 'vitest.setup.js');
  if (!exists(setupPath)) {
    writeIfChanged(setupPath, `// Auto-generated by js-sanitizer setup for Vitest
// Optional setup for Vitest runs; Mocha ignores this.
try { require('@babel/register')({ extensions: ['.js','.jsx','.ts','.tsx'], cache: true }); } catch {}
`);
    log('Created vitest.setup.js');
  }

  // Optional plugin wiring only when Vitest is actually present
  if (!hasAnyDep('vite-plugin-babel')) {
    ensureDevDepInPkg('vite-plugin-babel', '*');
    tryInstall(['vite-plugin-babel'], true);
  }

  // Respect existing Vitest configs; only generate a minimal one if none exist
  const existingCfg = [
    path.join(ROOT, 'vitest.config.ts'),
    path.join(ROOT, 'vitest.config.mjs'),
    path.join(ROOT, 'vitest.config.js'),
  ].find(exists);

  if (existingCfg) {
    log(`${path.basename(existingCfg)} present; not modifying Vitest config.`);
    return;
  }

  const outPath = path.join(ROOT, 'vitest.config.mjs'); // safe for ESM/CJS
  const content = `// Auto-generated by js-sanitizer setup
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node', setupFiles: ['./vitest.setup.js'] }
});
`;
  writeIfChanged(outPath, content);
  log(`Created ${path.basename(outPath)} (minimal Vitest config).`);
})();


/* ----------------------------------------
 * 5) Final dependency hints / base Babel
 * --------------------------------------*/
(function finalHints() {
  if (!hasDep('@babel/core')) {
    log('Missing @babel/core/@babel/preset-env.');
    tryInstall(['@babel/core', '@babel/preset-env'], true);
    if (!hasDep('@babel/core')) {
      log('WARNING: @babel/core not detected. Install: npm i -D @babel/core @babel/preset-env');
    }
  } else {
    log('@babel/core detected.');
  }
  log('Setup complete.');
})();
