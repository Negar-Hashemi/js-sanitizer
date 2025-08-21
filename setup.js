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

const ROOT = process.env.INIT_CWD || process.cwd();
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

    // 2a) Ensure TOP-LEVEL plugins array contains our plugin
    if (!src.includes(PLUGIN_NAME)) {
      const pluginsArrayRegex = /plugins\s*:\s*\[([\s\S]*?)\]/m;
      if (pluginsArrayRegex.test(src)) {
        // Append into existing array with proper comma handling
        src = src.replace(pluginsArrayRegex, (m, inner) => {
          const trimmed = inner.trim();
          const hasTrailingComma = /,\s*$/.test(inner);
          const innerNoTrailWS = inner.replace(/\s*$/, '');
          const sep = trimmed ? (hasTrailingComma ? ' ' : ', ') : '';
          return `plugins: [${innerNoTrailWS}${sep}'${PLUGIN_NAME}']`;
        });
        changed = true;
      } else {
        // Insert a new plugins array near the start of the exported object
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

    // 2b) Avoid duplicating preset-env: ONLY add if completely missing (keep your options intact)
    if (!/['"]@babel\/preset-env['"]/.test(src)) {
      // If a presets array exists, prepend ours; else insert a new presets field.
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
      log(`Updated ${path.basename(targetPath)}: ensured ${PLUGIN_NAME} and no duplicate preset-env`);
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
        p.globals = p.globals || {};
        p.globals['ts-jest'] = Object.assign({}, p.globals['ts-jest'], { babelConfig: true });
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
 * 3) Mocha wiring (@babel/register)
 * --------------------------------------*/
(function ensureMocha() {
  if (!hasDep('mocha')) {
    log('Mocha not detected — skipping Mocha wiring.');
    return;
  }

  if (!hasDep('@babel/register')) {
    log('Missing @babel/register for Mocha.');
    tryInstall(['@babel/register'], true);
    if (!hasDep('@babel/register')) {
      log('WARNING: @babel/register not found. Install: npm i -D @babel/register');
    }
  }

  const BABEL_REGISTER = path.join(ROOT, 'babel.register.js');
  const MOCHA_RC = path.join(ROOT, '.mocharc.json');

  const regContent =
`// Auto-generated by js-sanitizer setup
try {
  require('@babel/register')({
    extensions: ['.js', '.jsx', '.ts', '.tsx'],
    cache: true
  });
} catch (e) {
  console.warn('[js-sanitizer] Mocha: @babel/register not found. Install with: npm i -D @babel/register');
}`;
  writeIfChanged(BABEL_REGISTER, regContent);

  let mocharc = exists(MOCHA_RC) ? readJSON(MOCHA_RC) : {};
  const req = new Set(ensureArray(mocharc.require));
  req.add('./babel.register.js');
  mocharc.require = Array.from(req);
  writeJSON(MOCHA_RC, mocharc);
  log('Ensured .mocharc.json requires ./babel.register.js (Babel active for Mocha).');
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
