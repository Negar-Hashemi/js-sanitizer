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

const pkg = readJSON(PKG_PATH) || {};
const isESMProject = pkg.type === 'module';
const hasDep = (name) => !!(pkg.dependencies?.[name] || pkg.devDependencies?.[name] || pkg.peerDependencies?.[name]);

log(`Using project root: ${ROOT}`);

/* ----------------------------------------
 * 1) Ensure Babel config + modules:false
 * --------------------------------------*/
(function ensureBabelConfig() {
  // Prefer .cjs in ESM projects to avoid "module is not defined"
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

  // Update JSON configs if present
  const jsonPaths = ['.babelrc', '.babelrc.json'].map(f => path.join(ROOT, f));
  for (const p of jsonPaths) {
    if (!exists(p)) continue;
    const cfg = readJSON(p) || {};
    cfg.presets = ensureArray(cfg.presets);
    const idx = cfg.presets.findIndex(e => (Array.isArray(e) ? e[0] : e) === '@babel/preset-env');
    if (idx === -1) {
      cfg.presets.push(["@babel/preset-env", { targets: { node: "current" }, modules: false }]);
    } else {
      const entry = cfg.presets[idx];
      if (Array.isArray(entry)) {
        const opts = entry[1] || {};
        if (opts.modules !== false) opts.modules = false;
        if (!opts.targets) opts.targets = { node: "current" };
        cfg.presets[idx] = ["@babel/preset-env", opts];
      } else {
        cfg.presets[idx] = ["@babel/preset-env", { targets: { node: "current" }, modules: false }];
      }
    }
    cfg.plugins = ensureArray(cfg.plugins);
    if (!cfg.plugins.includes(PLUGIN_NAME)) cfg.plugins.push(PLUGIN_NAME);
    writeJSON(p, cfg);
    log(`Updated ${path.basename(p)} with ${PLUGIN_NAME} and modules:false`);
    return;
  }

  // Update code-based config if present; else create a minimal one
  if (exists(targetPath)) {
    let src = read(targetPath);

    if (!src.includes(PLUGIN_NAME)) {
      const pluginsArrayRegex = /plugins\s*:\s*\[([\s\S]*?)\]/m;
      if (pluginsArrayRegex.test(src)) {
        src = src.replace(pluginsArrayRegex, (m, inner) => {
          const trimmed = inner.trim();
          const needsComma = trimmed && !trimmed.endsWith(',');
          const insertion = (needsComma ? inner + ' ' : inner) + `'${PLUGIN_NAME}',`;
          return `plugins: [${insertion}]`;
        });
      } else {
        src = src.replace(/module\.exports\s*=\s*\{/, match => {
          return `${match}\n  plugins: ['${PLUGIN_NAME}'],`;
        });
      }
    }

    if (!/modules:\s*false/.test(src)) {
      if (/@babel\/preset-env"\s*,\s*\{/.test(src)) {
        src = src.replace(/@babel\/preset-env"\s*,\s*\{([^}]*)\}/, (m, inner) => {
          const trimmed = inner.trim();
          const comma = trimmed && !trimmed.endsWith(',') ? ',' : '';
          return `@babel/preset-env", { ${inner}${comma} modules: false }`;
        });
      } else if (/presets\s*:\s*\[/.test(src)) {
        src = src.replace(/presets\s*:\s*\[/, `presets: [["@babel/preset-env", { targets: { node: "current" }, modules: false }], `);
      } else {
        src = src.replace(/module\.exports\s*=\s*\{/, match => {
          return `${match}
  presets: [["@babel/preset-env", { targets: { node: "current" }, modules: false }]],`;
        });
      }
    }

    writeIfChanged(targetPath, src);
    log(`Ensured ${PLUGIN_NAME} and modules:false in ${path.basename(targetPath)}`);
    return;
  }

  const content =
`module.exports = {
  presets: [
    ["@babel/preset-env", { targets: { node: "current" }, modules: false }]
  ],
  plugins: ['${PLUGIN_NAME}'],
  comments: true
};
`;
  fs.writeFileSync(targetPath, content);
  log(`Created ${path.basename(targetPath)} (ESM-safe, modules:false)`);
})();

/* ----------------------------------------
 * 2) Jest wiring (babel-jest)
 * --------------------------------------*/
(function ensureJest() {
  if (!hasDep('jest')) {
    log('Jest not detected — skipping Jest wiring.');
    return;
  }

  if (!hasDep('babel-jest')) {
    log('Missing babel-jest for Jest.');
    tryInstall(['babel-jest'], true);
    if (!hasDep('babel-jest')) {
      log('WARNING: babel-jest not found. Install: npm i -D babel-jest');
    }
  }

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

  const JEST_FILES = ['jest.config.js', 'jest.config.cjs'].map(f => path.join(ROOT, f));
  const cfgPath = JEST_FILES.find(exists);
  if (cfgPath) {
    let src = read(cfgPath);
    if (/['"]babel-jest['"]/.test(src)) {
      log(`${path.basename(cfgPath)} already references babel-jest`);
      return;
    }
    const objectHeader = /module\.exports\s*=\s*\{/m;
    if (objectHeader.test(src)) {
      const transformRegex = /transform\s*:\s*\{([\s\S]*?)\}/m;
      if (transformRegex.test(src)) {
        src = src.replace(transformRegex, (m, inner) => {
          if (/babel-jest/.test(inner)) return m;
          const trimmed = inner.trim();
          const needsComma = trimmed && !trimmed.endsWith(',');
          const insertion = (needsComma ? inner + ' ' : inner) + `'${'^.+\\\\.[jt]sx?$'}': 'babel-jest',`;
          return `transform: {${insertion}}`;
        });
      } else {
        src = src.replace(objectHeader, match => {
          return `${match}
  transform: { '^.+\\\\.[jt]sx?$': 'babel-jest' },`;
        });
      }
      writeIfChanged(cfgPath, src);
      log(`Updated ${path.basename(cfgPath)}: ensured babel-jest transform`);
      return;
    }
    log(`Found ${path.basename(cfgPath)} but could not safely edit; please ensure transform uses babel-jest.`);
    return;
  }

  const newCfg =
`/** Auto-generated by js-sanitizer setup */
module.exports = {
  testEnvironment: 'node',
  transform: { '^.+\\\\.[jt]sx?$': 'babel-jest' }
};`;
  writeIfChanged(path.join(ROOT, 'jest.config.js'), newCfg);
  log('Created jest.config.js using babel-jest transform');
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
 * 4) Vitest wiring (self-healing config)
 * --------------------------------------*/
(function ensureVitest() {
  // If Vitest missing, optionally bootstrap it when auto-install is enabled
  if (!hasDep('vitest')) {
    if (process.env.JS_SANITIZER_AUTO_INSTALL === '1') {
      log('Vitest not detected. Attempting to auto-install vitest…');
      const ok = tryInstall(['vitest'], true);
      if (!ok && !hasDep('vitest')) {
        log('Vitest not detected and auto-install failed — skipping Vitest wiring.');
        return;
      }
    } else {
      log('Vitest not detected — skipping Vitest wiring.');
      return;
    }
  }

  // Decide file extension:
  // - If project is ESM ("type":"module"), use .js
  // - Otherwise use .mjs so we can use ESM syntax safely
  const outPath = isESMProject
    ? path.join(ROOT, 'vitest.config.js')
    : path.join(ROOT, 'vitest.config.mjs');

  // Write a config that conditionally imports vite-plugin-babel at runtime.
  // This avoids ERR_MODULE_NOT_FOUND during fresh installs while still enabling
  // the plugin automatically when it’s present.
  const makeConfig = () => `// Auto-generated by js-sanitizer setup
import { defineConfig } from 'vitest/config'

export default defineConfig(async () => {
  const plugins = [];
  try {
    const { default: babel } = await import('vite-plugin-babel');
    plugins.push(
      babel({
        // Only transform test/spec files
        filter: /(\\.test|\\.spec)\\.[jt]sx?$/,
        // Reuse your babel config file (modules:false + js-sanitizer)
        babelConfig: { configFile: true }
      })
    );
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

  // Respect existing TS configs; don’t attempt to edit them.
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
      // Only write our config if the existing file is ours and content differs.
      // If it’s a user-maintained file, we just log guidance to avoid breaking changes.
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

  // Ensure a setup file entry exists (idempotent)
  const setupPath = path.join(ROOT, 'vitest.setup.js');
  if (!exists(setupPath)) {
    writeIfChanged(setupPath, `// Auto-generated by js-sanitizer setup
// Optional setup; not required for Babel in Vite
try { require('@babel/register')({ extensions: ['.js','.jsx','.ts','.tsx'], cache: true }); } catch {}
`);
  }
  const vit = pkg.vitest || {};
  const setupFiles = new Set(ensureArray(vit.setupFiles));
  setupFiles.add('./vitest.setup.js');
  vit.setupFiles = Array.from(setupFiles);
  pkg.vitest = vit;
  writeJSON(PKG_PATH, pkg);
  log('Added ./vitest.setup.js to package.json → vitest.setupFiles');
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
