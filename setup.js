#!/usr/bin/env node
/**
 * js-sanitizer setup (Jest + Mocha + Vitest)
 * - Operates in consumer project (prefers npm_config_local_prefix / INIT_CWD)
 * - Ensures Babel config exists, includes plugin, and keeps ESM (modules:false)
 * - Wires Jest (babel-jest / ts-jest), Mocha (custom @babel/core require-hook), Vitest (vite-plugin-babel)
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
  transform: { '^.+\\.ts$': 'ts-jest' },
  globals: { 'ts-jest': { babelConfig: true } }
};
`
    : `/** Auto-generated by js-sanitizer setup */
module.exports = {
  testEnvironment: 'node',
  transform: { '^.+\\.[jt]sx?$': 'babel-jest' }
};
`;

  writeIfChanged(path.join(ROOT, 'jest.config.js'), newCfg);
  log(`Created jest.config.js for ${hasTsJest ? 'ts-jest (with Babel pass)' : 'babel-jest'}`);
})();

/* ----------------------------------------
 * 3) Mocha wiring  (uses custom @babel/core require-hook)
 * --------------------------------------*/
(function ensureMocha() {
  // Ensure minimum dev deps (auto-install only if JS_SANITIZER_AUTO_INSTALL=1)
  if (!hasAnyDep('@babel/core')) tryInstall(['@babel/core'], true);
  if (!hasAnyDep('@babel/preset-env')) tryInstall(['@babel/preset-env'], true);
  if (!hasAnyDep('@babel/plugin-transform-modules-commonjs')) {
    tryInstall(['@babel/plugin-transform-modules-commonjs'], true);
  }

  // If the project actually uses TypeScript anywhere, having the TS preset is best.
  const tsPresent = hasAnyDep('typescript') || hasAnyDep('@types/mocha') || hasAnyDep('@types/node');
  if (tsPresent && !hasAnyDep('@babel/preset-typescript')) {
    tryInstall(['@babel/preset-typescript'], true);
  }

  // 1) Write/update the ESM loader (Node loader API: resolve/load)
  //    - Ignores .d.ts by short-circuiting to `export {}`
  //    - Transpiles .ts/.tsx on the fly using Babel (env + optional typescript preset)
  const LOADER_PATH = path.resolve(ROOT, 'sanitizer.esm.loader.mjs'); // keep your existing name
  const loaderSrc = `/* generated by js-sanitizer */
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

let transformAsync;

async function ensureBabel() {
  if (!transformAsync) {
    const core = await import('@babel/core');
    transformAsync = core.transformAsync;
  }
}

async function loadPresets() {
  const env = await import('@babel/preset-env');
  let ts = null;
  try { ts = await import('@babel/preset-typescript'); } catch {}
  const presets = [[env.default, { targets: { node: 'current' }, modules: false }]];
  if (ts) presets.push([ts.default ?? ts, { allowDeclareFields: true, onlyRemoveTypeImports: true }]);
  return presets;
}

// Keep strict pass-through for resolution. We only care about loading certain files.
export async function resolve(specifier, context, nextResolve) {
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  // Non-files: defer
  if (!url.startsWith('file:')) return nextLoad(url, context);

  // Ignore declaration files entirely
  if (url.endsWith('.d.ts')) {
    return { format: 'module', source: 'export {}; /* js-sanitizer: ignored .d.ts */', shortCircuit: true };
  }

  // Transpile real TS/TSX with Babel when present
  if (url.endsWith('.ts') || url.endsWith('.tsx')) {
    const filename = fileURLToPath(url);
    const source = await fs.readFile(filename, 'utf8');

    await ensureBabel();
    const presets = await loadPresets();
    const hasTsPreset = presets.length >= 2; // env + typescript

    if (!hasTsPreset) {
      throw new Error('[js-sanitizer] @babel/preset-typescript is required to execute TypeScript. ' +
        'Set JS_SANITIZER_AUTO_INSTALL=1 or add it to devDependencies.');
    }

    const { code } = await transformAsync(source, {
      filename,
      presets,
      sourceMaps: 'inline',
      babelrc: true,
      rootMode: 'upward-optional'
      // If you need to force the sanitizer plugin here too, you can add it,
      // but we prefer relying on the project babel config that setup.js patched.
      // plugins: [['module:js-sanitizer', {}]],
    });

    return { format: 'module', source: code, shortCircuit: true };
  }

  // Everything else: continue the chain
  return nextLoad(url, context);
}
`;
  writeIfChanged(LOADER_PATH, loaderSrc);
  log('Ensured sanitizer.esm.loader.mjs');

  // 2) Write/update CJS bootstrap that:
  //    - Enables custom @babel/core require-hook for CJS-loaded tests
  //    - Registers the ESM loader via node:module.register
  const REGISTER_PATH = path.resolve(ROOT, 'babel.register.cjs');
  const registerSrc = `// Auto-generated by js-sanitizer
// Custom require-hook using @babel/core (no @babel/register worker)
// Safe for Mocha/Vitest Node-side tests. Deterministic; ignores project Babel configs.

if (global.__JS_SANITIZER_HOOK__) {
  // Prevent double install in watch modes
  module.exports = global.__JS_SANITIZER_HOOK__;
  return;
}
global.__JS_SANITIZER_HOOK__ = true;

const fs = require('fs');
const path = require('path');
const Module = require('module');

let babel;
try { babel = require('@babel/core'); }
catch (e) {
  console.warn('[js-sanitizer] Missing @babel/core. Install: npm i -D @babel/core');
  throw e;
}

// Optional (better stacktraces if present)
try { require('source-map-support/register'); } catch {}

const EXTS = (process.env.JS_SANITIZER_EXTS || '.js,.jsx,.ts,.tsx,.cjs')
  .split(',').map(s => s.trim()).filter(Boolean);

// Skip vendor/build dirs
const IGNORE_RE = /[\\/](node_modules|dist|build|out)[\\/]/;

// Deterministic options; keep \`caller\` primitives-only
const BASE_OPTS = {
  babelrc: false,
  configFile: false,
  comments: true,
  sourceMaps: 'inline',
  parserOpts: { allowReturnOutsideFunction: true, sourceType: 'unambiguous' },
  caller: {
    name: 'js-sanitizer',
    version: '1',
    supportsStaticESM: false,
    supportsTopLevelAwait: false
  },
  plugins: [
    'module:js-sanitizer',
    [require.resolve('@babel/plugin-transform-modules-commonjs'), { loose: true }],
  ],
};

const CACHE = new Map(); // filename+mtime -> code

function compileFile(code, filename) {
  const key = filename + ':' + (fs.statSync(filename).mtimeMs | 0);
  if (CACHE.has(key)) return CACHE.get(key);

  const ext = path.extname(filename);
  const opts = { ...BASE_OPTS, filename };

  // TS support: require preset only when we actually see TS
  if (ext === '.ts' || ext === '.tsx') {
    let tsPreset;
    try { tsPreset = require.resolve('@babel/preset-typescript'); }
    catch {
      throw new Error(
        \`[js-sanitizer] TypeScript file "\${path.relative(process.cwd(), filename)}" detected. \` +
        \`Please install @babel/preset-typescript: npm i -D @babel/preset-typescript\`
      );
    }
    opts.presets = [tsPreset];
  }

  const out = babel.transformSync(code, opts);
  const result = out && out.code ? out.code : code;
  CACHE.set(key, result);
  return result;
}

// Patch require for selected extensions
for (const ext of EXTS) {
  const prior = Module._extensions[ext] || Module._extensions['.js'];
  Module._extensions[ext] = function registerHook(mod, filename) {
    if (IGNORE_RE.test(filename)) return prior(mod, filename);
    const src = fs.readFileSync(filename, 'utf8');
    const compiled = compileFile(src, filename);
    mod._compile(compiled, filename);
  };
}

console.log('[js-sanitizer] require-hook active for', EXTS.join(', '));

// Optional: ESM loader for native \`import\` paths (Node >= 20)
(async () => {
  if (process.env.JS_SANITIZER_DISABLE_ESM_LOADER === '1') {
    console.log('[js-sanitizer] ESM loader disabled via env');
    return;
  }
  try {
    let register, pathToFileURL;
    try {
      ({ register } = require('node:module'));
      ({ pathToFileURL } = require('node:url'));
    } catch {
      ({ register } = await import('node:module'));
      ({ pathToFileURL } = await import('node:url'));
    }
    if (typeof register === 'function') {
      const loaderPath = path.resolve(__dirname, 'sanitizer.esm.loader.mjs');
      register(loaderPath, pathToFileURL(process.cwd() + '/'));
      console.log('[js-sanitizer] ESM loader registered');
    } else {
      console.warn('[js-sanitizer] node:module.register unavailable; ESM imports may bypass sanitizer');
    }
  } catch (e) {
    console.warn('[js-sanitizer] Could not register ESM loader:', e?.message || e);
  }
})();

`;
  writeIfChanged(REGISTER_PATH, registerSrc);
  log('Ensured babel.register.cjs');

  // 3) Ensure Mocha config requires the bootstrap and includes TS extensions
  const absRegister = REGISTER_PATH;
  const wantExt = ['js','cjs','mjs','ts','tsx','jsx'];

  function patchJsMochaConfig(jsCfgPath) {
    let src = read(jsCfgPath);
    let changed = false;

    // Remove any legacy node-option (loader flags) — we register programmatically now
    src = src.replace(/['"]node-option['"]\s*:\s*\[[\s\S]*?\],?\s*\n?/m, m => { changed = true; return ''; });

    // Ensure require array exists & includes absRegister
    const requireArrRx = /(^|\n)\s*require\s*:\s*\[([\s\S]*?)\]/m;
    if (requireArrRx.test(src)) {
      src = src.replace(requireArrRx, (m, _head, inner) => {
        const has = new RegExp(`['"\`]${absRegister.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\$&')}['"\`]`).test(inner);
        if (has) return m;
        const trimmed = inner.trim();
        const sep = trimmed && !/,\s*$/.test(inner) ? ', ' : '';
        changed = true;
        return `require: [${inner.replace(/\s*$/, '')}${sep}${JSON.stringify(absRegister)}]`;
      });
    } else {
      // Inject at top-level object
      const cjsHeader = /module\.exports\s*=\s*\{\s*/m;
      const esmHeader = /export\s+default\s*\{\s*/m;
      if (cjsHeader.test(src)) {
        src = src.replace(cjsHeader, mm => { changed = true; return `${mm}\n  require: [${JSON.stringify(absRegister)}],`; });
      } else if (esmHeader.test(src)) {
        src = src.replace(esmHeader, mm => { changed = true; return `${mm}\n  require: [${JSON.stringify(absRegister)}],`; });
      }
    }

    // Ensure extension includes TS/TSX
    const extRx = /(^|\n)\s*extension\s*:\s*\[([\s\S]*?)\]/m;
    if (extRx.test(src)) {
      src = src.replace(extRx, (m, _h, inner) => {
        const current = new Set(inner.split(',').map(s => s.replace(/['"\s]/g,'')).filter(Boolean));
        for (const e of wantExt) current.add(e);
        changed = true;
        return `extension: [${Array.from(current).map(e => '\'' + e + '\'').join(', ')}]`;
      });
    } else {
      const header = /module\.exports\s*=\s*\{\s*|export\s+default\s*\{\s*/m;
      if (header.test(src)) {
        src = src.replace(header, mm => { changed = true; return `${mm}\n  extension: [${wantExt.map(e=>'\''+e+'\'').join(', ')}],`; });
      }
    }

    if (changed) writeIfChanged(jsCfgPath, src);
    log(`${path.basename(jsCfgPath)} ${changed ? 'patched' : 'already OK'} (require + extensions).`);
  }

  function patchJsonMochaConfig(jsonPath) {
    const mocharc = exists(jsonPath) ? (readJSON(jsonPath) || {}) : {};
    delete mocharc['node-option'];

    // require
    const req = new Set(ensureArray(mocharc.require));
    req.add(absRegister);
    mocharc.require = Array.from(req);

    // extension
    const ext = new Set(ensureArray(mocharc.extension).map(String));
    for (const e of wantExt) ext.add(e);
    mocharc.extension = Array.from(ext);

    writeJSON(jsonPath, mocharc);
    log(`${path.basename(jsonPath)} patched (require + extensions; node-option removed).`);
  }

  function ensureMochaOpts() {
    const testDir = exists(path.join(ROOT, 'test')) ? path.join(ROOT, 'test') : ROOT;
    const OPTS = path.join(testDir, 'mocha.opts');
    if (!exists(OPTS)) return false;
    let content = read(OPTS);

    // remove any --node-option lines (we register loader programmatically)
    content = content.split('\n').filter(l => !/^\s*--node-option\b/.test(l)).join('\n');

    // ensure --require <absRegister>
    const requireLine = `--require ${absRegister}`;
    if (!new RegExp(`^\\s*${requireLine.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\$&')}\\s*$`, 'm').test(content)) {
      if (content && !content.endsWith('\n')) content += '\n';
      content += requireLine + '\n';
    }

    // ensure TS extensions
    for (const e of ['--extension ts', '--extension tsx']) {
      if (!new RegExp(`^\\s*${e}\\s*$`, 'm').test(content)) content += e + '\n';
    }

    writeIfChanged(OPTS, content);
    log(`Ensured --require/--extension in ${path.relative(ROOT, OPTS)} (legacy mocha.opts).`);
    return true;
  }

  const jsCfg = ['.mocharc.js', '.mocharc.cjs', '.mocharc.mjs'].map(f => path.join(ROOT, f)).find(exists);
  const jsonCfg = path.join(ROOT, '.mocharc.json');

  if (jsCfg) { patchJsMochaConfig(jsCfg); return; }
  if (exists(jsonCfg)) { patchJsonMochaConfig(jsonCfg); return; }
  if (ensureMochaOpts()) return;

  // No config? Create minimal .mocharc.cjs with require + extensions
  const NEW = path.join(ROOT, '.mocharc.cjs');
  const content = `// Auto-generated by js-sanitizer setup
const path = require('path');
module.exports = {
  require: [${JSON.stringify(absRegister)}],
  extension: ['js','cjs','mjs','ts','tsx','jsx']
};
`;
  writeIfChanged(NEW, content);
  log('Created .mocharc.cjs (require + extensions).');
})();



/* ----------------------------------------
 * 4) Vitest wiring (only if Vitest is actually used)
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
// Keep this lightweight; transforms are handled by vite-plugin-babel + project Babel config.
// Add mocks/polyfills here if needed.
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
import babel from 'vite-plugin-babel';

export default defineConfig({
  plugins: [
    // Only transform test/spec files; respect project Babel config
    babel({
      filter: /\\b(test|spec)\\.[cm]?[jt]sx?$/i,
      babelConfig: {
        babelrc: true,
        configFile: true
      }
    })
  ],
  test: { environment: 'node', setupFiles: ['./vitest.setup.js'] }
});
`;
  writeIfChanged(outPath, content);
  log(`Created ${path.basename(outPath)} (Vitest + vite-plugin-babel).`);
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
  if (!hasDep('@babel/plugin-transform-modules-commonjs')) {
    tryInstall(['@babel/plugin-transform-modules-commonjs'], true);
  }
  log('Setup complete.');
})();
