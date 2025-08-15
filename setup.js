#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const configFileNames = [
  'babel.config.js',
  '.babelrc',
  '.babelrc.json'
];

const MIN_BABEL_VERSION = [7, 22, 0]; // minimum supported version

// ------------------ Helpers ------------------
function detectTestingFramework() {
  const pkgPath = path.resolve(process.cwd(), 'package.json');
  if (!fs.existsSync(pkgPath)) return null;

  const pkg = require(pkgPath);
  if (pkg.devDependencies?.jest || pkg.dependencies?.jest) return 'jest';
  if (pkg.devDependencies?.vitest || pkg.dependencies?.vitest) return 'vitest';
  if (pkg.devDependencies?.mocha || pkg.dependencies?.mocha) return 'mocha';
  return null;
}

function isESModuleProject() {
  const pkgPath = path.resolve(process.cwd(), 'package.json');
  if (!fs.existsSync(pkgPath)) return false;
  const pkg = require(pkgPath);
  return pkg.type === 'module';
}

function backupFile(filePath) {
  if (fs.existsSync(filePath)) {
    const backupPath = filePath + '.bak';
    if (!fs.existsSync(backupPath)) {
      fs.copyFileSync(filePath, backupPath);
      console.log(`Backup created: ${backupPath}`);
    }
  }
}

// ------------------ Babel Config ------------------
function createDefaultBabelConfig() {
  const esModule = isESModuleProject();
  const fileName = esModule ? 'babel.config.cjs' : 'babel.config.js';
  const fullPath = path.resolve(process.cwd(), fileName);

  const content = `module.exports = {
  presets: [
    ["@babel/preset-env", { targets: { node: "current" } }]
  ],
  plugins: ["module:js-sanitizer"],
  comments: true
};
`;
  fs.writeFileSync(fullPath, content, 'utf8');
  console.log(`Created default ${fileName} with js-sanitizer plugin.`);
  return fullPath;
}

function findBabelConfig() {
  for (const file of configFileNames) {
    const fullPath = path.resolve(process.cwd(), file);
    if (fs.existsSync(fullPath)) return fullPath;
  }
  return null;
}

// ------------------ Vitest Config ------------------
function findVitestConfig() {
  const possibleFiles = [
    'vitest.config.js',
    'vite.config.js',
    'vitest.config.ts',
    'vite.config.ts'
  ];
  for (const file of possibleFiles) {
    const fullPath = path.resolve(process.cwd(), file);
    if (fs.existsSync(fullPath)) return fullPath;
  }
  return null;
}

function updateVitestConfig() {
  const configPath = findVitestConfig();
  const vitestConfigContent = `
import { defineConfig } from 'vite';
import babel from 'vite-plugin-babel';

export default defineConfig({
  plugins: [babel()],
  test: {
    globals: true,
    environment: 'jsdom' // default, can override per-file with docblock
  }
});
`;

  if (configPath) {
    backupFile(configPath);
    let content = fs.readFileSync(configPath, 'utf8');
    if (!content.includes("vite-plugin-babel") && !content.includes("js-sanitizer")) {
      content += `\n// Added by js-sanitizer setup\nplugins.push(babel());\n`;
      fs.writeFileSync(configPath, content, 'utf8');
      console.log(`Updated existing Vitest config: ${path.basename(configPath)}`);
    } else {
      console.log(`Vitest config already has js-sanitizer plugin.`);
    }
  } else {
    const newConfigPath = path.resolve(process.cwd(), 'vitest.config.js');
    fs.writeFileSync(newConfigPath, vitestConfigContent.trim(), 'utf8');
    console.log(`No Vitest config found. Created default vitest.config.js with js-sanitizer plugin.`);
  }
}

// ------------------ Babel Version Check ------------------
function checkBabelVersion() {
  const pkgPath = path.resolve(process.cwd(), 'package.json');
  if (!fs.existsSync(pkgPath)) return;

  const pkg = require(pkgPath);
  const babelVersionString =
    pkg.devDependencies?.["@babel/core"] ||
    pkg.dependencies?.["@babel/core"];

  if (!babelVersionString) {
    console.warn("[WARNING] @babel/core is not installed. Please install version >= 7.22.0");
    return;
  }

  const versionMatch = babelVersionString.match(/\d+\.\d+\.\d+/);
  if (!versionMatch) return;

  const [major, minor] = versionMatch[0].split('.').map(Number);
  const needsUpdate =
    major < MIN_BABEL_VERSION[0] ||
    (major === MIN_BABEL_VERSION[0] && minor < MIN_BABEL_VERSION[1]);

  if (needsUpdate) {
    console.warn(`[WARNING] Your @babel/core version (${versionMatch[0]}) is too old. Updating to >= ${MIN_BABEL_VERSION.join('.')}`);
    try {
      execSync(`npm install --save-dev @babel/core@^7.22.0 @babel/preset-env@^7.22.0`, { stdio: 'inherit' });
    } catch (err) {
      console.error("Automatic update failed. Please update manually.");
    }
  }
}

// ------------------ Main ------------------
(function main() {
  console.log(`########### SETUP JS-SANITIZER #################`);

  const framework = detectTestingFramework();
  if (!framework) {
    console.log("No supported testing framework detected (jest, vitest, mocha). Skipping setup.");
    return;
  }

  // Babel
  let babelConfigPath = findBabelConfig();
  if (!babelConfigPath) babelConfigPath = createDefaultBabelConfig();

  checkBabelVersion();

  // Vitest
  if (framework === 'vitest') {
    updateVitestConfig();
  }

  console.log(`Detected ${framework}. Setup complete.`);
})();
