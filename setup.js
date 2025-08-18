#!/usr/bin/env node
/**
 * js-sanitizer setup (Jest + Mocha + Vitest)
 * - Operates in consumer project root (INIT_CWD)
 * - Ensures Babel config exists, includes plugin, and keeps ESM (modules:false)
 * - Wires Jest (babel-jest), Mocha (@babel/register), Vitest (vite-plugin-babel or @vitejs/plugin-react)
 * - Idempotent, conservative edits with clear logs
 */
const fs = require('fs');
const path = require('path');

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
    // presets
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
    // plugins
    cfg.plugins = ensureArray(cfg.plugins);
    if (!cfg.plugins.includes(PLUGIN_NAME)) cfg.plugins.push(PLUGIN_NAME);
    writeJSON(p, cfg);
    log(`Updated ${path.basename(p)} with ${PLUGIN_NAME} and modules:false`);
    return;
  }

  // Update code-based config if present; else create minimal one
  if (exists(targetPath)) {
    let src = read(targetPath);

    // Ensure plugins includes our plugin
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

    // Ensure preset-env has modules:false (best-effort)
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
    log('WARNING: babel-jest not found. Install: npm i -D babel-jest');
  }

  // package.json "jest"
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

  // jest.config.(js|cjs)
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

  // Create minimal config
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

  if (!hasDep('@babel/register')) {
    log('WARNING: @babel/register not found. Install: npm i -D @babel/register');
  }
})();

/* ----------------------------------------
 * 4) Vitest wiring — always create config + setup
 * --------------------------------------*/
(function ensureVitest() {
  if (!hasDep('vitest')) {
    log('Vitest not detected — skipping Vitest wiring.');
    return;
  }

  const hasViteBabel = hasDep('vite-plugin-babel');
  const hasViteReact = hasDep('@vitejs/plugin-react');

  // 4a) Always create a setup file (harmless; some users keep globals here)
  const setupPath = path.join(ROOT, 'vitest.setup.js');
  if (!exists(setupPath)) {
    writeIfChanged(
      setupPath,
`// Auto-generated by js-sanitizer setup
// Optional; not required for Babel-in-Vite
try { require('@babel/register')({ extensions: ['.js','.jsx','.ts','.tsx'], cache: true }); } catch {}
`
    );
    // Ensure package.json → vitest.setupFiles includes it
    const vit = pkg.vitest || {};
    const setupFiles = new Set(ensureArray(vit.setupFiles));
    setupFiles.add('./vitest.setup.js');
    vit.setupFiles = Array.from(setupFiles);
    pkg.vitest = vit;
    writeJSON(PKG_PATH, pkg);
    log('Added ./vitest.setup.js to package.json → vitest.setupFiles');
  }

  // 4b) Decide config file path and always create one if missing
  const outPath = (pkg.type === 'module')
    ? path.join(ROOT, 'vitest.config.js')   // ESM project → .js
    : path.join(ROOT, 'vitest.config.mjs'); // CJS project → .mjs (ESM syntax inside)

  // Build content based on available plugins
  let content;
  if (hasViteBabel) {
    // Preferred: vite-plugin-babel with enforce:'pre' so docblocks reach Babel intact
    content =
`// Auto-generated by js-sanitizer setup
import { defineConfig } from 'vitest/config'
import babel from 'vite-plugin-babel'

export default defineConfig({
  test: {
    // add your test options as needed
  },
  plugins: [
    // Run before other transforms so js-sanitizer sees docblocks
    { enforce: 'pre', ...babel({
      // Only transform test/spec files
      filter: /(\\.test|\\.spec)\\.[jt]sx?$/,
      // Reuse babel.config.* (modules:false + module:js-sanitizer)
      babelConfig: { configFile: true }
    }) }
  ]
})
`;
  } else if (hasViteReact) {
    // Fallback: many projects already include @vitejs/plugin-react
    content =
`// Auto-generated by js-sanitizer setup
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  test: {
    // add your test options as needed
  },
  plugins: [
    react({
      // Either reuse your babel.config.*:
      // babel: { configFile: true },
      // Or inject just the sanitizer plugin:
      babel: { plugins: ['module:js-sanitizer'] }
    })
  ]
})
`;
  } else {
    // Neither plugin is present — create a config shell with clear instructions
    content =
`// Auto-generated by js-sanitizer setup
// To enable js-sanitizer in Vitest, install ONE of:
//   npm i -D vite-plugin-babel
//      (then add the vite-plugin-babel block with enforce:'pre')
// or
//   npm i -D @vitejs/plugin-react
//      (then add react({ babel: { plugins: ['module:js-sanitizer'] } }))

import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    // add options as needed
  }
})
`;
    log('WARNING: Neither vite-plugin-babel nor @vitejs/plugin-react detected. Created vitest.config.* with instructions.');
  }

  if (exists(outPath)) {
    const src = read(outPath);
    // If it already contains a suitable plugin reference, leave it alone
    if (/vite-plugin-babel/.test(src) || /@vitejs\/plugin-react/.test(src)) {
      log(`${path.basename(outPath)} already contains a suitable plugin config.`);
      return;
    }
    log(`Found ${path.basename(outPath)}. Not overwriting. Please add one of the plugin blocks manually (see comments inside the file).`);
    return;
  }

  writeIfChanged(outPath, content);
  log(`Created ${path.basename(outPath)} for Vitest.`);
})();

/* ----------------------------------------
 * 5) Final dependency hints
 * --------------------------------------*/
(function finalHints() {
  if (!hasDep('@babel/core')) {
    log('WARNING: @babel/core not detected. Install: npm i -D @babel/core @babel/preset-env');
  } else {
    log('@babel/core detected.');
  }
  log('Setup complete.');
})();
