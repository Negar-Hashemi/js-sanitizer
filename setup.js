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
  const localPrefix = process.env.npm_config_local_prefix;
  if (localPrefix && fs.existsSync(path.join(localPrefix, 'package.json'))) {
    return localPrefix;
  }
  if (process.env.INIT_CWD && fs.existsSync(path.join(process.env.INIT_CWD, 'package.json'))) {
    return process.env.INIT_CWD;
  }
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

// ---- safe package.json updater ----
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

// snapshot
const pkg = readJSON(PKG_PATH) || {};
const isESMProject = pkg.type === 'module';
const hasDep = (name) => !!(pkg.dependencies?.[name] || pkg.devDependencies?.[name] || pkg.peerDependencies?.[name]);

log(`Using project root: ${ROOT}`);

/* ----------------------------------------
 * 1) Ensure Babel config + modules:false (+ TS when present)
 * --------------------------------------*/
(function ensureBabelConfig() {
  const targetBabelFile = isESMProject ? 'babel.config.cjs' : 'babel.config.js';
  const targetPath = path.join(ROOT, targetBabelFile);

  // Rename to .cjs for ESM projects if using CJS export
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

  // Helpers for JSON-based configs (tuple-safe)
  const addPluginToJSONCfg = (cfg) => {
    const arr = Array.isArray(cfg.plugins) ? cfg.plugins.slice() : [];
  
    let present = false;
    const fixed = arr.map((entry) => {
      if (Array.isArray(entry)) {
        // If tuple *is* the sanitizer, it's present.
        if (entry[0] === PLUGIN_NAME) present = true;
  
        // If sanitizer accidentally got appended inside another tuple, strip it out.
        const idx = entry.findIndex(v => v === PLUGIN_NAME);
        if (idx > 0) {
          const copy = entry.slice();
          copy.splice(idx, 1);
          return copy;
        }
        return entry;
      }
  
      if (entry === PLUGIN_NAME) present = true;
      return entry;
    });
  
    if (!present) fixed.push(PLUGIN_NAME);
    cfg.plugins = fixed;
    return cfg;
  };
  


  const ensurePresetInJSONCfg = (cfg, presetName, presetConfig) => {
    cfg.presets = Array.isArray(cfg.presets) ? cfg.presets.slice() : [];
    const hasPreset = cfg.presets.some(p => {
      if (typeof p === 'string') return p === presetName;
      if (Array.isArray(p)) return p[0] === presetName;
      return false;
    });
    if (!hasPreset) cfg.presets.push([presetName, presetConfig]);
    return cfg;
  };

  // Important: preset-env's "exclude" must be strings/regex only
  const sanitizePresetEnvExclude = (cfg) => {
    if (!cfg.presets) return cfg;
    cfg.presets = cfg.presets.map((p) => {
      if (Array.isArray(p) && p[0] === '@babel/preset-env' && p[1] && typeof p[1] === 'object') {
        const opt = { ...p[1] };
        if (Array.isArray(opt.exclude)) {
          opt.exclude = opt.exclude.filter(item =>
            typeof item === 'string' ||
            (item && typeof item === 'object' && typeof item.test === 'function')
          );
        }
        return ['@babel/preset-env', opt];
      }
      return p;
    });
    return cfg;
  };

  const typescriptPresent = hasAnyDep('typescript');

  // 1) JSON-based configs
  const jsonPaths = ['.babelrc', '.babelrc.json'].map(f => path.join(ROOT, f));
  for (const p of jsonPaths) {
    if (!exists(p)) continue;
    let cfg = readJSON(p) || {};
    cfg = ensurePresetInJSONCfg(cfg, '@babel/preset-env', { targets: { node: 'current' }, modules: false });
    if (typescriptPresent) {
      cfg = ensurePresetInJSONCfg(cfg, '@babel/preset-typescript', { allowDeclareFields: true });
    }
    cfg = sanitizePresetEnvExclude(cfg);
    cfg = addPluginToJSONCfg(cfg);
    writeJSON(p, cfg);
    log(`Updated ${path.basename(p)}: ensured presets and ${PLUGIN_NAME} (exclude sanitized)`);
    return;
  }

  // 2) Code-based config present → edit conservatively
if (exists(targetPath)) {
  let src = read(targetPath);
  let changed = false;

  // Remove any accidental preset tuples from preset-env "exclude"
function fixPresetEnvExclude(code) {
  // Targets first @babel/preset-env options block that has exclude: [...]
  return code.replace(
    /(presets\s*:\s*\[[\s\S]*?['"]@babel\/preset-env['"][\s\S]*?\{\s*[^}]*?\bexclude\s*:\s*\[)([\s\S]*?)(\])/m,
    (m, head, content, tail) => {
      // Remove entries that look like preset tuples: ["@babel/preset-xxx", {...}]
      let cleaned = content.replace(
        /(^|,)\s*\[\s*['"]@babel\/preset-[^'"]+['"][\s\S]*?\](?=,|$)/g,
        (mm, lead) => (lead || '')
      );
      cleaned = cleaned.replace(/,\s*,/g, ',').replace(/^\s*,|,\s*$/g, '');
      return head + cleaned + tail;
    }
  );
}

// Strip sanitizer if it ended up *inside* any plugin tuple
function stripSanitizerInsideTuples(inner) {
  // Only touch nested [ ... ] blocks inside the plugins array
  return inner.replace(/\[([^\]]*?)\]/g, (m, tupleInner) => {
    let t = tupleInner.replace(
      /(^|,)\s*(['"])module:js-sanitizer\2\s*(?=,|$)/g,
      (mm, lead) => (lead || '')
    );
    t = t.replace(/,\s*,/g, ',').replace(/^\s*,|,\s*$/g, '');
    return '[' + t + ']';
  });
}

// Safely append sanitizer to every `plugins: [ ... ]` block (depth-aware)
function addSanitizerToPluginsBlocks(code, pluginName) {
  let i = 0;
  while (true) {
    const keyIdx = code.indexOf('plugins', i);
    if (keyIdx === -1) break;

    const colonIdx = code.indexOf(':', keyIdx);
    const openIdx  = code.indexOf('[', keyIdx);
    if (colonIdx === -1 || openIdx === -1 || colonIdx > openIdx) {
      i = keyIdx + 7; // move past 'plugins'
      continue;
    }

    // Walk to matching closing bracket using depth counting
    let j = openIdx + 1, depth = 1;
    while (j < code.length && depth > 0) {
      const ch = code[j];
      if (ch === '[') depth++;
      else if (ch === ']') depth--;
      j++;
    }
    if (depth !== 0) break; // unbalanced; give up

    const inner = code.slice(openIdx + 1, j - 1);

    // 1) clean any accidental tuple insertion
    const cleanedInner = stripSanitizerInsideTuples(inner);

    // 2) if sanitizer not already present at top-level, append it
    const hasTopLevel = /(^|,)\s*(['"])module:js-sanitizer\2\s*(?=,|$)/.test(
      cleanedInner.replace(/\[[^\]]*\]/g, '') // ignore tuples when checking top-level
    );

    let nextInner = cleanedInner;
    if (!hasTopLevel) {
      const needsComma = cleanedInner.trim().length > 0 && !/,\s*$/.test(cleanedInner.trim());
      nextInner = cleanedInner.replace(/\s*$/, '') + (needsComma ? ', ' : '') + `'${pluginName}'`;
    }

    // Splice back
    code = code.slice(0, openIdx + 1) + nextInner + code.slice(j - 1);
    i = openIdx + 1 + nextInner.length; // continue after this array
  }
  return code;
}


  // --- helpers for code-based configs ---
  // remove sanitizer when it was mistakenly appended as the 3rd element of a plugin tuple
  function stripSanitizerFromPluginTuples(s) {
    // specific: ['babel-plugin-transform-rename-properties', { ... }, 'module:js-sanitizer']
    s = s.replace(
      /(\[\s*['"]babel-plugin-transform-rename-properties['"]\s*,\s*\{[\s\S]*?\})\s*,\s*['"]module:js-sanitizer['"](\s*\])/g,
      '$1$2'
    );
    // generic safety: any plugin tuple that ends with ,'module:js-sanitizer']
    s = s.replace(
      /(\[\s*['"][^'"]+['"][^\]]*?)\s*,\s*['"]module:js-sanitizer['"](\s*\])/g,
      '$1$2'
    );
    return s;
  }

  // tokenize the top-level items of an array literal string
  function splitTopLevelArray(inner) {
    const parts = [];
    let cur = '';
    let depthSq = 0, depthCurly = 0, depthPar = 0;
    let str = null; // '\'' or '"'
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (str) {
        cur += ch;
        if (ch === str && inner[i - 1] !== '\\') str = null;
        continue;
      }
      if (ch === '"' || ch === '\'') { str = ch; cur += ch; continue; }
      if (ch === '[') { depthSq++; cur += ch; continue; }
      if (ch === ']') { depthSq--; cur += ch; continue; }
      if (ch === '{') { depthCurly++; cur += ch; continue; }
      if (ch === '}') { depthCurly--; cur += ch; continue; }
      if (ch === '(') { depthPar++; cur += ch; continue; }
      if (ch === ')') { depthPar--; cur += ch; continue; }
      if (ch === ',' && depthSq === 0 && depthCurly === 0 && depthPar === 0) {
        parts.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts;
  }

  function ensureTopLevelSanitizerInPlugins(source) {
    const rx = /plugins\s*:\s*\[([\s\S]*?)\]/m;
    const m = rx.exec(source);
    if (!m) return source; // no plugins array found
    const inner = m[1];
    const items = splitTopLevelArray(inner);
    const hasTop = items.some(x => x === `'${PLUGIN_NAME}'` || x === `"${PLUGIN_NAME}"`);
    if (hasTop) return source;

    const sep = inner.trim() ? ', ' : '';
    const replaced = source.replace(rx, (_whole, body) => {
      return `plugins: [${body.replace(/\s*$/, '')}${sep}'${PLUGIN_NAME}']`;
    });
    return replaced;
  }

  // 1) clean up previous bad insertion (tuple)
  const cleaned = stripSanitizerFromPluginTuples(src);
  if (cleaned !== src) { src = cleaned; changed = true; }

  // --- Inject ONLY into env.commonjs.plugins if present (Jest path) ---
  (function injectIntoCommonjsEnv() {
    let localChanged = false;

    function appendIntoPluginsBlock(source, blockLabelRegex) {
      return source.replace(blockLabelRegex, (whole, head, body) => {
        const pluginsRx = /plugins\s*:\s*\[([\s\S]*?)\]/m;
        if (pluginsRx.test(body)) {
          body = body.replace(pluginsRx, (m, inner) => {
            // use the robust top-level check
            const items = splitTopLevelArray(inner);
            const hasTop = items.some(x => x === `'${PLUGIN_NAME}'` || x === `"${PLUGIN_NAME}"`);
            if (hasTop) return m; // already present as top-level
            const sep = inner.trim() ? ', ' : '';
            localChanged = true;
            return `plugins: [${inner.replace(/\s*$/, '')}${sep}'${PLUGIN_NAME}']`;
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

  // 2a) Ensure top-level plugins contains our plugin (robust; not a naive .includes)
  const before = src;
  src = ensureTopLevelSanitizerInPlugins(src);
  if (src !== before) changed = true;

  src = fixPresetEnvExclude(src);
  src = addSanitizerToPluginsBlocks(src, PLUGIN_NAME);

  // 2b) Ensure @babel/preset-env exists (unchanged from your version)
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

  // 2c) If TypeScript is present, ensure @babel/preset-typescript exists (unchanged)
  const typescriptPresent = hasAnyDep('typescript');
  if (typescriptPresent && !/['"]@babel\/preset-typescript['"]/.test(src)) {
    const presetsArrayRegex = /presets\s*:\s*\[([\s\S]*?)\]/m;
    if (presetsArrayRegex.test(src)) {
      src = src.replace(presetsArrayRegex, (m, inner) => {
        if (inner.includes(`'@babel/preset-typescript'`) || inner.includes(`"@babel/preset-typescript"`)) return m;
        const sep = inner.trim() ? ', ' : '';
        return `presets: [${inner.replace(/\s*$/, '')}${sep}["@babel/preset-typescript", { allowDeclareFields: true }]]`;
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
    log(`Updated ${path.basename(targetPath)}: fixed tuple placement and ensured top-level ${PLUGIN_NAME}.`);
  } else {
    log(`${path.basename(targetPath)} already OK.`);
  }
  return;
}


  // 3) No config found → minimal one
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
 * 2) Jest wiring
 * --------------------------------------*/
(function ensureJest() {
  const freshPkg = readJSON(PKG_PATH) || {};
  const scriptsTest = String(freshPkg.scripts?.test || '');
  const jestReferenced = hasAnyDep('jest') || /(^|[\s;(&|])jest(\s|$)/.test(scriptsTest);
  if (!jestReferenced) {
    log('Jest not detected — skipping Jest wiring.');
    return;
  }

  const hasTsJest = hasAnyDep('ts-jest');
  const usesTS = hasAnyDep('typescript') || hasTsJest || hasAnyDep('@types/jest');

  if (!hasAnyDep('@babel/core')) tryInstall(['@babel/core'], true);
  if (!hasAnyDep('@babel/preset-env')) tryInstall(['@babel/preset-env'], true);
  if (usesTS && !hasAnyDep('@babel/preset-typescript')) tryInstall(['@babel/preset-typescript'], true);
  if (!hasAnyDep('jest-docblock')) tryInstall(['jest-docblock'], true);

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
        if (!p.jest.transform[tsKey]) p.jest.transform[tsKey] = 'ts-jest';
        p.jest.globals = p.jest.globals || {};
        const cur = p.jest.globals['ts-jest'] || {};
        p.jest.globals['ts-jest'] = Object.assign({}, cur, { babelConfig: true });
        log('Enabled ts-jest → Babel pass via package.json');
      } else {
        p.jest.transform = p.jest.transform || {};
        const KEY = '^.+\\.[jt]sx?$';
        if (p.jest.transform[KEY] !== 'babel-jest') {
          p.jest.transform[KEY] = 'babel-jest';
          log('Set package.json jest.transform → babel-jest for JS/TS files');
        }
        if (!hasAnyDep('babel-jest')) tryInstall(['babel-jest'], true);
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
      log(`${path.basename(jestCfgPath)} present; not modifying user config.`);
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
 * 3) Mocha wiring (custom @babel/core require-hook) — Sails-safe
 * --------------------------------------*/
(function ensureMocha() {
  if (!hasAnyDep('@babel/core')) tryInstall(['@babel/core'], true);
  if (!hasAnyDep('@babel/preset-env')) tryInstall(['@babel/preset-env'], true);
  if (!hasAnyDep('@babel/plugin-transform-modules-commonjs')) tryInstall(['@babel/plugin-transform-modules-commonjs'], true);
  if (!hasAnyDep('jest-docblock')) tryInstall(['jest-docblock'], true);

  const tsPresent = hasAnyDep('typescript') || hasAnyDep('@types/mocha') || hasAnyDep('@types/node');
  if (tsPresent && !hasAnyDep('@babel/preset-typescript')) tryInstall(['@babel/preset-typescript'], true);

  const freshPkg = readJSON(PKG_PATH) || {};
  const scriptsTest = String(freshPkg.scripts?.test || '');
  const IS_SAILS =
    freshPkg.name === 'sails' ||
    hasAnyDep('sails') ||
    /\bsails\b/.test(scriptsTest);

  // 1) ESM loader
  const LOADER_PATH = path.resolve(ROOT, 'sanitizer.esm.loader.mjs');
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

export async function resolve(specifier, context, nextResolve) {
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (!url.startsWith('file:')) return nextLoad(url, context);
  if (url.endsWith('.d.ts')) {
    return { format: 'module', source: 'export {}; /* js-sanitizer: ignored .d.ts */', shortCircuit: true };
  }
  if (url.endsWith('.ts') || url.endsWith('.tsx')) {
    const filename = fileURLToPath(url);
    const source = await fs.readFile(filename, 'utf8');
    await ensureBabel();
    const presets = await loadPresets();
    const hasTsPreset = presets.length >= 2;
    if (!hasTsPreset) {
      throw new Error('[js-sanitizer] @babel/preset-typescript is required to execute TypeScript. Set JS_SANITIZER_AUTO_INSTALL=1 or add it.');
    }
    const { code } = await transformAsync(source, {
      filename,
      presets,
      sourceMaps: 'inline',
      babelrc: true,
      rootMode: 'upward-optional'
    });
    return { format: 'module', source: code, shortCircuit: true };
  }
  return nextLoad(url, context);
}
`;
  writeIfChanged(LOADER_PATH, loaderSrc);
  log('Ensured sanitizer.esm.loader.mjs');

  // 2) CJS bootstrap: require-hook + ESM loader registration
  const REGISTER_PATH = path.resolve(ROOT, 'babel.register.cjs');
  const REGISTER_REL = './babel.register.cjs';

  const registerSrc = String.raw`// Auto-generated by js-sanitizer
// Custom require-hook using @babel/core (no @babel/register worker)
// Safe for Mocha/Vitest Node-side tests. Deterministic; reads project Babel config.

if (global.__JS_SANITIZER_HOOK__) {
  module.exports = global.__JS_SANITIZER_HOOK__;
} else {
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

  try { require('source-map-support/register'); } catch {}

  const SELF_PATH = __filename.toLowerCase();
  const EXTS = (process.env.JS_SANITIZER_EXTS || '.js,.jsx,.ts,.tsx,.mjs,.cjs')
    .split(',').map(s => s.trim()).filter(Boolean);

  function isIgnoredFile(filename) {
    if (!filename) return true;
    const lower = filename.toLowerCase();
    const sep = path.sep;
    if (lower === SELF_PATH) return true; // don't compile this bootstrap
    if (lower.includes(sep + 'node_modules' + sep)) return true;
    if (lower.includes(sep + 'dist' + sep)) return true;
    if (lower.includes(sep + 'build' + sep)) return true;
    if (lower.includes(sep + 'out' + sep)) return true;
    if (lower.includes(sep + 'js-sanitizer' + sep)) return true;
    if (/[\\/]\.(git|hg|svn)[\\/]/i.test(lower)) return true;
    return false;
  }

  function isTestFixture(filename) {
    if (!filename) return false;
    const lower = filename.toLowerCase();
    const sep = path.sep;
    if (!lower.includes(sep + 'test' + sep)) return false;
    if (lower.includes(sep + 'samples' + sep)) return true;
    if (lower.includes(sep + 'fixtures' + sep)) return true;
    const base = path.basename(lower);
    if (/^(rollup|vite|webpack)\.config\.[cm]?[jt]sx?$/.test(base)) return true;
    return false;
  }

  const BASE_OPTS = {
    babelrc: true,
    configFile: true,
    rootMode: 'upward-optional',
    comments: true,
    sourceMaps: 'inline',
    // Keep parsing sane; no top-level 'return' hacks
    parserOpts: { sourceType: 'unambiguous' },
    caller: {
      name: 'js-sanitizer',
      version: '1',
      supportsStaticESM: false,
      supportsTopLevelAwait: false
    },
    ignore: [/node_modules[\\/](js-sanitizer)[\\/]/i]
  };

  const CACHE = new Map();

  function compileFile(code, filename) {
    const key = filename + ':' + (fs.statSync(filename).mtimeMs | 0);
    if (CACHE.has(key)) return CACHE.get(key);

    const ext = path.extname(filename);
    const opts = Object.assign({}, BASE_OPTS, { filename });

    if (ext === '.ts' || ext === '.tsx') {
      let tsPreset;
      try { tsPreset = require.resolve('@babel/preset-typescript'); }
      catch {
        throw new Error(
          '[js-sanitizer] TypeScript file "' + path.relative(process.cwd(), filename) + '" detected. ' +
          'Please install @babel/preset-typescript: npm i -D @babel/preset-typescript'
        );
      }
      opts.presets = [tsPreset];
    }

    const out = babel.transformSync(code, opts);
    const result = out && out.code ? out.code : code;
    CACHE.set(key, result);
    return result;
  }

  for (const ext of EXTS) {
    const prior = Module._extensions[ext] || Module._extensions['.js'];
    if (prior && prior.__js_sanitizer_patched) continue;

    function registerHook(mod, filename) {
      if (isIgnoredFile(filename) || isTestFixture(filename)) {
        return prior(mod, filename);
      }
      const src = fs.readFileSync(filename, 'utf8');
      const compiled = compileFile(src, filename);
      mod._compile(compiled, filename);
    }
    registerHook.__js_sanitizer_patched = true;
    Module._extensions[ext] = registerHook;
  }

  console.log('[js-sanitizer] require-hook active for', EXTS.join(', '));

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
        const loaderFsPath = path.resolve(__dirname, 'sanitizer.esm.loader.mjs');
        const loaderURL = pathToFileURL(loaderFsPath).href;
        const parentURL = pathToFileURL(process.cwd() + path.sep).href;
        register(loaderURL, parentURL);
        console.log('[js-sanitizer] ESM loader registered');
      } else {
        console.warn('[js-sanitizer] node:module.register unavailable; ESM imports may bypass sanitizer');
      }
    } catch (e) {
      console.warn('[js-sanitizer] Could not register ESM loader:', e && (e.message || e));
    }
  })();
}
`;

  writeIfChanged(REGISTER_PATH, registerSrc);
  log('Ensured babel.register.cjs');

  // 3) SAFE wiring: preserve bootstrap; avoid --extension for Sails/older Mocha; remove @babel/register duplicates
  function ensureMochaScripts(pkgPath, registerRel) {
    if (!exists(pkgPath)) return false;
    const pkg = readJSON(pkgPath) || {};
    let changed = false;
    if (pkg.scripts && typeof pkg.scripts === 'object') {
      for (const [k, v] of Object.entries(pkg.scripts)) {
        if (typeof v !== 'string') continue;
        if (!/\bmocha\b/.test(v)) continue;
        let next = v;

        // remove any prior -r @babel/register to avoid double hooks
        next = next.replace(/\s+-r\s+@babel\/register\b/g, '');
        next = next.replace(/\s+--require\s+@babel\/register\b/g, '');

        const hasOurRequire = new RegExp(`(?:^|\\s)(?:-r|--require)\\s+${registerRel.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\$&')}\\b`).test(next);
        if (!hasOurRequire) next = next.replace(/\bmocha\b/, `mocha -r ${registerRel}`);

        if (next !== v) {
          pkg.scripts[k] = next;
          changed = true;
        }
      }
    }
    if (changed) {
      writeJSON(pkgPath, pkg);
      log(`package.json scripts patched (-r ${registerRel}; removed @babel/register).`);
    } else {
      log('package.json scripts already OK or no mocha scripts found.');
    }
    return changed;
  }

  function patchJsonMochaConfig(jsonPath, registerRel, allowExtension) {
    const mocharc = exists(jsonPath) ? (readJSON(jsonPath) || {}) : {};
    const req = new Set(ensureArray(mocharc.require));
    // drop @babel/register if present
    for (const r of Array.from(req)) {
      if (typeof r === 'string' && /@babel\/register\b/.test(r)) req.delete(r);
    }
    req.add(registerRel);
    mocharc.require = Array.from(req);

    if (allowExtension) {
      const WANT_EXT = ['js','cjs','mjs','ts','tsx','jsx'];
      const ext = new Set(ensureArray(mocharc.extension).map(String));
      for (const e of WANT_EXT) ext.add(e);
      mocharc.extension = Array.from(ext);
    }
    writeJSON(jsonPath, mocharc);
    log(`${path.basename(jsonPath)} merged (require${allowExtension ? ' + extensions' : ''}; removed @babel/register).`);
  }

  function patchMochaOpts(optsPath, registerRel, allowExtension) {
    let content = exists(optsPath) ? read(optsPath) : '';
    let lines = content.split(/\r?\n/);

    // strip any --require @babel/register lines
    lines = lines.filter(l => !/^\s*(?:-r|--require)\s+@babel\/register\b/.test(l));

    if (!allowExtension) {
      lines = lines.filter(l => !/^\s*--extension\b/.test(l));
    }

    function ensureLine(line) {
      const rx = new RegExp(`^\\s*${line.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*$`, 'm');
      if (!rx.test(lines.join('\n'))) lines.push(line);
    }

    ensureLine(`--require ${registerRel}`);
    if (allowExtension) {
      ensureLine(`--extension ts`);
      ensureLine(`--extension tsx`);
    }

    const next = lines.filter((l, i, arr) => i === 0 || l !== '' || arr[i - 1] !== '').join('\n');
    writeIfChanged(optsPath, next.endsWith('\n') ? next : next + '\n');
    log(`${path.relative(ROOT, optsPath)} ensured (--require${allowExtension ? ' + TS extensions' : ''}).`);
  }

  const jsRc = ['.mocharc.js', '.mocharc.cjs', '.mocharc.mjs'].map(f => path.join(ROOT, f)).find(exists);
  const jsonRc = path.join(ROOT, '.mocharc.json');
  const hasJsonRc = exists(jsonRc);

  if (jsRc) {
    ensureMochaScripts(PKG_PATH, REGISTER_REL);
  } else if (hasJsonRc) {
    patchJsonMochaConfig(jsonRc, REGISTER_REL, /*allowExtension*/ !IS_SAILS);
  } else {
    const optsCandidates = [
      path.join(ROOT, 'test', 'mocha.opts'),
      path.join(ROOT, '.mocha.opts'),
      path.join(ROOT, 'mocha.opts'),
    ];
    const foundOpts = optsCandidates.find(exists);
    if (foundOpts) {
      patchMochaOpts(foundOpts, REGISTER_REL, /*allowExtension*/ !IS_SAILS);
    } else {
      const NEW = path.join(ROOT, '.mocharc.cjs');
      const WANT_EXT = ['js','cjs','mjs','ts','tsx','jsx'];
      const content =
`// Auto-generated by js-sanitizer setup (minimal Mocha rc)
module.exports = {
  require: ['${REGISTER_REL}']${IS_SAILS ? '' : ',\n  extension: ' + JSON.stringify(WANT_EXT)}
};
`;
      writeIfChanged(NEW, content);
      log('Created .mocharc.cjs (require' + (IS_SAILS ? '' : ' + extensions') + ').');
    }
  }

  log('Mocha wiring complete (Sails-safe; no duplicate @babel/register; no invalid top-level return).');
})();

/* ----------------------------------------
 * 4) Vitest wiring
 * --------------------------------------*/
(function ensureVitest() {
  if (process.env.JS_SANITIZER_SKIP_VITEST === '1') {
    log('Vitest wiring skipped (JS_SANITIZER_SKIP_VITEST=1).');
    return;
  }

  const fresh = readJSON(PKG_PATH) || {};
  const scriptsTest = String(fresh.scripts?.test || '');
  const vitestInDeps = hasAnyDep('vitest');
  const vitestReferenced = vitestInDeps || /\bvitest\b/.test(scriptsTest);

  if (!vitestReferenced && process.env.JS_SANITIZER_VITEST_ALWAYS !== '1') {
    log('Vitest not detected — skipping Vitest wiring.');
    return;
  }

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

  if (!hasAnyDep('vite-plugin-babel')) {
    ensureDevDepInPkg('vite-plugin-babel', '*');
    tryInstall(['vite-plugin-babel'], true);
  }

  const existingCfg = [
    path.join(ROOT, 'vitest.config.ts'),
    path.join(ROOT, 'vitest.config.mjs'),
    path.join(ROOT, 'vitest.config.js'),
  ].find(exists);

  if (existingCfg) {
    log(`${path.basename(existingCfg)} present; not modifying Vitest config.`);
    return;
  }

  const outPath = path.join(ROOT, 'vitest.config.mjs');
  const content = `// Auto-generated by js-sanitizer setup
import { defineConfig } from 'vitest/config';
import babel from 'vite-plugin-babel';

export default defineConfig({
  plugins: [
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
