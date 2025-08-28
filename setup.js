#!/usr/bin/env node
/**
 * js-sanitizer setup (Jest + Mocha + Vitest)
 * - Operates in consumer project (INIT_CWD)
 * - Ensures Babel config exists, includes plugin, and keeps ESM (modules:false)
 * - Wires Jest (babel-jest), Mocha (@babel/register), Vitest (vite-plugin-babel)
 * - Idempotent, conservative edits; clear warnings
 * - Optional auto-install of missing devDeps when JS_SANITIZER_AUTO_INSTALL=1
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = (() => {
  // 1) If we're installed in <consumer>/node_modules/js-sanitizer,
  //    two levels up is the consumer package root.
  const twoUp = path.resolve(__dirname, '..', '..');
  if (
    fs.existsSync(path.join(twoUp, 'package.json')) &&
    !/node_modules[\\/]/.test(twoUp) // guard against odd layouts
  ) {
    return twoUp;
  }

  // 2) npm/pnpm/yarn set this to the package being installed INTO
  const localPrefix = process.env.npm_config_local_prefix;
  if (
    localPrefix &&
    fs.existsSync(path.join(localPrefix, 'package.json')) &&
    // ensure it's not our own package folder (dependency)
    path.basename(localPrefix) !== 'js-sanitizer'
  ) {
    return localPrefix;
  }

  // 3) INIT_CWD is often the monorepo root; still better than CWD in postinstall
  if (
    process.env.INIT_CWD &&
    fs.existsSync(path.join(process.env.INIT_CWD, 'package.json'))
  ) {
    return process.env.INIT_CWD;
  }

  // 4) Last resort
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

// ---- NEW: safe package.json updater (prevents stale overwrite) ----
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
 * 1) Ensure Babel config + modules:false
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

  // 1) JSON-based configs (do not disturb existing presets/options)
  const jsonPaths = ['.babelrc', '.babelrc.json'].map(f => path.join(ROOT, f));
  for (const p of jsonPaths) {
    if (!exists(p)) continue;
    const cfg = readJSON(p) || {};
    const updated = addPluginToJSONCfg(cfg);
    writeJSON(p, updated);
    log(`Updated ${path.basename(p)}: ensured plugins include ${PLUGIN_NAME}`);
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
        // Matches the start of the object literal and captures its body
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
            // No plugins array: insert one at the top of the object literal body
            localChanged = true;
            body = body.replace(/^\s*/, match => `${match}plugins: ['${PLUGIN_NAME}'],\n`);
          }
          return `${head}${body}}`;
        });
      }

      // Find the env.commonjs block only (do not touch browser/esm/etc.)
      // This regex targets the inner object for the "commonjs" env key.
      const envCommonjs = /(\bcommonjs\s*:\s*\{\s*)([\s\S]*?)\}/m;
      if (envCommonjs.test(src)) {
        src = appendIntoPluginsBlock(src, envCommonjs);
      }

      if (localChanged) changed = true;
    })();

    // 2a) If we didn't inject via env.commonjs (plugin still not present),
    // ensure a TOP-LEVEL plugins array contains our plugin (generic fallback).
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
        // Insert a new top-level plugins array if there isn't one anywhere
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

    // 2b) Avoid duplicating preset-env: ONLY add if completely missing
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

    if (changed) {
      writeIfChanged(targetPath, src);
      log(`Updated ${path.basename(targetPath)}: ensured ${PLUGIN_NAME} in env.commonjs (or top-level fallback) and no duplicate preset-env`);
    } else {
      log(`${path.basename(targetPath)} already contains ${PLUGIN_NAME} and preset-env`);
    }
    return;
  }

  // 3) No config found → create a minimal one
  const minimal =
`module.exports = {
  presets: [
    ["@babel/preset-env", { targets: { node: "current" }, modules: false }]
  ],
  plugins: ['${PLUGIN_NAME}'],
  comments: true
};
`;
  fs.writeFileSync(targetPath, minimal);
  log(`Created ${path.basename(targetPath)} (minimal, includes ${PLUGIN_NAME})`);
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

  // Ensure Babel bits (ts projects also need preset-typescript)
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
  // Docblock reader used by many tag parsers
  if (!hasAnyDep('jest-docblock')) {
    tryInstall(['jest-docblock'], true);
  }

  // If project has NO explicit Jest config file but DOES have a package.json "jest" block,
  // prefer to edit that in-place to enable Babel in ts-jest.
  const pkgHasInlineJest = !!freshPkg.jest && typeof freshPkg.jest === 'object';

  // --- NEW: migrate misplaced top-level globals['ts-jest'] into jest.globals['ts-jest']
  if (pkgHasInlineJest && freshPkg.globals && freshPkg.globals['ts-jest']) {
    updatePkg((p) => {
      p.jest = p.jest || {};
      p.jest.globals = p.jest.globals || {};
      const fromTop = p.globals && p.globals['ts-jest'] || {};
      const current = p.jest.globals['ts-jest'] || {};
      p.jest.globals['ts-jest'] = Object.assign({}, current, fromTop, { babelConfig: true });
      // cleanup top-level if empty after move
      if (p.globals) {
        delete p.globals['ts-jest'];
        if (Object.keys(p.globals).length === 0) delete p.globals;
      }
      return p;
    });
    log('Moved top-level globals.ts-jest → jest.globals["ts-jest"] with babelConfig:true');
  }

  // If no inline jest block and no file config, we will create jest.config.js below.
  const JEST_FILES = ['jest.config.js', 'jest.config.cjs'].map(f => path.join(ROOT, f));
  const jestCfgPath = JEST_FILES.find(exists);

  if (pkgHasInlineJest) {
    // Mutate inline package.json jest safely (fresh read/write)
    updatePkg((p) => {
      p.jest = p.jest || {};
      // Keep existing transforms; ensure ts-jest path has Babel enabled
      if (hasTsJest) {
        p.jest.transform = p.jest.transform || {};
        // Respect existing ts-jest transform if present; otherwise set it
        const tsKey = '^.+\\.ts$';
        if (!p.jest.transform[tsKey]) {
          p.jest.transform[tsKey] = 'ts-jest';
        }
        // >>> FIX: write under jest.globals (not top-level)
        p.jest.globals = p.jest.globals || {};
        const cur = p.jest.globals['ts-jest'] || {};
        p.jest.globals['ts-jest'] = Object.assign({}, cur, { babelConfig: true });
        log('Enabled ts-jest → Babel pass via package.json jest.globals["ts-jest"].babelConfig');
      } else {
        // Fallback to babel-jest if no ts-jest
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
    // Jest config file exists; try a gentle augmentation only if it's our auto-generated file
    const src = read(jestCfgPath);
    if (/Auto-generated by js-sanitizer setup/.test(src)) {
      let out = src;
      if (hasTsJest) {
        // Swap to ts-jest with babel pass if our file used babel-jest
        out = out.replace(
          /transform:\s*\{[^}]*\}/m,
          `transform: { '^.+\\\\.ts$': 'ts-jest' },\n  globals: { 'ts-jest': { babelConfig: true } }`
        );
      } else {
        // Ensure babel-jest present for JS projects
        if (!hasAnyDep('babel-jest')) tryInstall(['babel-jest'], true);
      }
      writeIfChanged(jestCfgPath, out);
      log(`Updated ${path.basename(jestCfgPath)} for ${hasTsJest ? 'ts-jest + Babel' : 'babel-jest'}`);
    } else {
      log(`${path.basename(jestCfgPath)} present; not modifying user config. Make sure it enables Babel (ts-jest babelConfig or babel-jest).`);
    }
    return;
  }

  // No config anywhere → create a minimal jest.config.js fit for the project
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
 * 3) Mocha wiring (@babel/register)  — robust + legacy-friendly
 * --------------------------------------*/
(function ensureMocha() {
  if (!hasAnyDep('mocha')) {
    log('Mocha not detected — skipping Mocha wiring.');
    return;
  }

  // The sanitizer plugin needs jest-docblock at runtime
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

  const BABEL_REGISTER = path.join(ROOT, 'babel.register.js');

  // Force-load the sanitizer for Mocha specs *even if* the project’s Babel config is complicated.
  // This does NOT mutate the app’s Webpack builds; it only affects Mocha’s on-the-fly transpilation.
  const regContent =
`// Auto-generated by js-sanitizer setup
try {
  require('@babel/register')({
    extensions: ['.js', '.jsx', '.ts', '.tsx'],
    cache: true,
    // Reuse local babel config if present, but force-append the sanitizer plugin for tests:
    babelrc: true,
    configFile: true,
    plugins: (function () {
      try {
        // Try to avoid duplicate insertion if project already includes it
        const cfg = require('./babel.config.js') || require('./babel.config.cjs');
        const list = (cfg && cfg.plugins) || [];
        const has = Array.isArray(list) && list.some(p =>
          (typeof p === 'string' && p === '${PLUGIN_NAME}') ||
          (Array.isArray(p) && p[0] === '${PLUGIN_NAME}')
        );
        return has ? [] : ['${PLUGIN_NAME}'];
      } catch (e) {
        return ['${PLUGIN_NAME}'];
      }
    })()
  });
} catch (e) {
  console.warn('[js-sanitizer] Mocha: @babel/register not found or failed. Install with: npm i -D @babel/register');
}`;
  writeIfChanged(BABEL_REGISTER, regContent);

  // Detect Mocha major version to decide config style (.mocharc vs mocha.opts)
  let mochaMajor = null;
  try {
    const pjson = readJSON(PKG_PATH) || {};
    const ver = (pjson.devDependencies && pjson.devDependencies.mocha)
             || (pjson.dependencies && pjson.dependencies.mocha)
             || '';
    const m = String(ver).match(/\d+/);
    mochaMajor = m ? parseInt(m[0], 10) : null;
  } catch {}

  // Mocha ≥6 supports .mocharc.*; older versions typically use mocha.opts
  if (mochaMajor && mochaMajor >= 6) {
    const MOCHA_RC = path.join(ROOT, '.mocharc.json');
    let mocharc = exists(MOCHA_RC) ? readJSON(MOCHA_RC) : {};
    const req = new Set(ensureArray(mocharc.require));
    req.add('./babel.register.js');
    mocharc.require = Array.from(req);
    writeJSON(MOCHA_RC, mocharc);
    log('Ensured .mocharc.json requires ./babel.register.js (Babel active for Mocha ≥6).');
  } else {
    // Legacy fallback: create/update mocha.opts (Mocha 3–5)
    // Put it in ./test or project root; prefer ./test if it exists
    const testDir = exists(path.join(ROOT, 'test')) ? path.join(ROOT, 'test') : ROOT;
    const OPTS = path.join(testDir, 'mocha.opts');
    let content = exists(OPTS) ? read(OPTS) : '';
    if (!/^-{1,2}require\s+\.\/babel\.register\.js/m.test(content)) {
      const prefix = content && !content.endsWith('\n') ? '\n' : '';
      content = `${content}${prefix}--require ./babel.register.js\n`;
      writeIfChanged(OPTS, content);
      log(`Added "--require ./babel.register.js" to ${path.relative(ROOT, OPTS)} (Mocha <6).`);
    } else {
      log(`mocha.opts already requires ./babel.register.js (Mocha <6).`);
    }
  }
})();


/* ----------------------------------------
 * 4) Vitest wiring (self-healing config + ensure vite-plugin-babel)
 * --------------------------------------*/
(function ensureVitest() {
  if (!hasAnyDep('vitest')) {
    if (process.env.JS_SANITIZER_AUTO_INSTALL === '1') {
      log('Vitest not detected. Attempting to add and auto-install vitest…');
      ensureDevDepInPkg('vitest', '*');
      const ok = tryInstall(['vitest'], true);
      if (!ok && !hasAnyDep('vitest')) {
        log('Vitest not detected and auto-install failed — skipping Vitest wiring.');
        return;
      }
    } else {
      log('Vitest not detected — skipping Vitest wiring.');
      return;
    }
  }

  // Ensure vite-plugin-babel is recorded and (optionally) installed.
  if (!hasAnyDep('vite-plugin-babel')) {
    log('vite-plugin-babel not found; adding to devDependencies.');
    ensureDevDepInPkg('vite-plugin-babel', '*');
    const installed = tryInstall(['vite-plugin-babel'], true);
    if (!hasAnyDep('vite-plugin-babel')) {
      log('WARNING: vite-plugin-babel is still missing. Run: npm i -D vite-plugin-babel');
    } else if (!installed) {
      log('NOTE: vite-plugin-babel added to package.json. Run your package manager install to fetch it.');
    }
  }

  const outPath = isESMProject
    ? path.join(ROOT, 'vitest.config.js')
    : path.join(ROOT, 'vitest.config.mjs');

  const makeConfig = () => `// Auto-generated by js-sanitizer setup
import { defineConfig } from 'vitest/config'

export default defineConfig(async () => {
  const plugins = [];
  try {
    const { default: babel } = await import('vite-plugin-babel');
    plugins.push(
      babel({
        // Broad but safe: *.test|spec.(js|jsx|ts|tsx|mjs|cjs)
        filter: /\\.(test|spec)\\.(?:[cm]?jsx?|tsx?)$/,
        babelConfig: { configFile: true, babelrc: true }
      })
    );
    console.info('[js-sanitizer] vite-plugin-babel enabled for test files');
  } catch (e) {
    // vite-plugin-babel not installed — tests will still run.
    // Install it to enable Babel transforms in Vitest:
    //   npm i -D vite-plugin-babel
  }

  return {
    test: {
      environment: 'node',
      setupFiles: ['./vitest.setup.js'],
    },
    plugins
  };
});
`;

  const existingCandidates = [
    path.join(ROOT, 'vitest.config.ts'),
    path.join(ROOT, 'vitest.config.mjs'),
    path.join(ROOT, 'vitest.config.js'),
  ];
  const existing = existingCandidates.find(exists);

  if (existing) {
    const base = path.basename(existing);
    if (base === 'vitest.config.ts') {
      log('vitest.config.ts detected — not auto-editing. If desired, mirror the async import pattern there.');
    } else {
      const src = read(existing);
      const oursMarker = src.includes('// Auto-generated by js-sanitizer setup');
      if (oursMarker) {
        writeIfChanged(existing, makeConfig());
        log(`Updated ${base} with conditional vite-plugin-babel wiring.`);
      } else {
        log(`${base} exists; not modifying. If you want self-healing wiring, copy this pattern into your file.`);
      }
    }
  } else {
    writeIfChanged(outPath, makeConfig());
    log(`Created ${path.basename(outPath)} with conditional vite-plugin-babel wiring.`);
  }

  // ---- IMPORTANT: write to package.json using updatePkg (fresh read) ----
  updatePkg((p) => {
    p.vitest = p.vitest || {};
    const s = new Set(ensureArray(p.vitest.setupFiles));
    s.add('./vitest.setup.js');
    p.vitest.setupFiles = Array.from(s);
    return p;
  });
  log('Added ./vitest.setup.js to package.json → vitest.setupFiles');

  // Ensure setup file exists
  const setupPath = path.join(ROOT, 'vitest.setup.js');
  if (!exists(setupPath)) {
    writeIfChanged(setupPath, `// Auto-generated by js-sanitizer setup
// Optional setup; not required for Babel in Vite
try { require('@babel/register')({ extensions: ['.js','.jsx','.ts','.tsx'], cache: true }); } catch {}
`);
  }
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
