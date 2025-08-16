#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const configFileNames = [
  'babel.config.js',
  'babel.config.cjs',
  // '.babelrc',
  // '.babelrc.json'
];
const MIN_BABEL_VERSION = [7, 22, 0];

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

// ------------------ Babel ------------------
function ensureBabelInstalled() {
  const pkg = require(path.resolve(process.cwd(), 'package.json'));
  if (
    !pkg.devDependencies?.["@babel/core"] &&
    !pkg.dependencies?.["@babel/core"]
  ) {
    console.log("Installing @babel/core and @babel/preset-env...");
    try {
      execSync(
        "npm install --save-dev @babel/core@^7.22.0 @babel/preset-env@^7.22.0",
        { stdio: "inherit" }
      );
    } catch (err) {
      console.error("Failed to install Babel. Please install manually.");
    }
  }
}

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
  const allFiles = [...configFileNames];
  for (const file of allFiles) {
    const fullPath = path.resolve(process.cwd(), file);
    if (fs.existsSync(fullPath)) return fullPath;
  }
  return null; // none exist
}

// ------------------ Update Babel Config ------------------
function updateBabelConfig(filePath) {
  backupFile(filePath);

  if (filePath.endsWith('.js') || filePath.endsWith('.cjs')) {
    let content = fs.readFileSync(filePath, 'utf8');

    // Add plugin if not present
    if (!content.includes('"js-sanitizer"') && !content.includes("'js-sanitizer'")) {
      const pluginsRegex = /(plugins\s*:\s*\[)([^]*?)(\])/m;
      if (pluginsRegex.test(content)) {
        content = content.replace(pluginsRegex, (_, start, existing, end) => {
          const trimmed = existing.trim();
          const newPlugins = trimmed.length ? trimmed + ', "module:js-sanitizer"' : '"module:js-sanitizer"';
          return `${start}${newPlugins}${end}`;
        });
      } else {
        // fallback if plugins not defined
        const moduleExportsRegex = /module\.exports\s*=\s*{([^]*?)}/m;
        if (moduleExportsRegex.test(content)) {
          content = content.replace(moduleExportsRegex, (_, body) => {
            return `module.exports = {${body.trim()},\n  plugins: ["module:js-sanitizer"],\n  comments: true\n}`;
          });
        } else {
          console.log(`Cannot automatically edit ${filePath}. Please add "module:js-sanitizer" manually.`);
          return;
        }
      }
    }

    // Ensure comments: true
    if (!/comments\s*:\s*true/.test(content)) {
      content = content.replace(/module\.exports\s*=\s*{/, "module.exports = {\n  comments: true,");
    }

    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`Updated Babel JS config: ${filePath}`);

  } else {
    // JSON / .babelrc
    let config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    config.plugins = config.plugins || [];
    if (!config.plugins.includes("module:js-sanitizer")) {
      config.plugins.push("module:js-sanitizer");
      console.log(`Added "js-sanitizer" plugin to ${path.basename(filePath)}`);
    }
    config.comments = true;
    fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf8');
    console.log(`Updated Babel JSON config: ${filePath}`);
  }
}

function updateBabelConfig(filePath) {
  const isJS = filePath.endsWith('.js') || filePath.endsWith('.cjs');

  if (isJS) {
    // Load the config
    let config;
    try {
      config = require(filePath);
    } catch (err) {
      console.error(`Failed to load ${filePath}:`, err);
      return;
    }

    config.plugins = config.plugins || [];
    if (!config.plugins.includes("module:js-sanitizer")) {
      config.plugins.push("module:js-sanitizer");
      console.log(`Added "module:js-sanitizer" to ${path.basename(filePath)}`);
    } else {
      console.log(`"module:js-sanitizer" already present in ${path.basename(filePath)}`);
    }

    config.comments = true;

    // Write back
    const content = `module.exports = ${JSON.stringify(config, null, 2)};\n`;
    fs.writeFileSync(filePath, content, 'utf8');
  } else {
    // JSON config
    let config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    config.plugins = config.plugins || [];
    if (!config.plugins.includes("module:js-sanitizer")) {
      config.plugins.push("module:js-sanitizer");
      console.log(`Added "module:js-sanitizer" to ${path.basename(filePath)}`);
    } else {
      console.log(`"module:js-sanitizer" already present in ${path.basename(filePath)}`);
    }
    config.comments = true;
    fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf8');
  }
}

// ------------------ Vitest ------------------
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
  plugins: [babel({ babelConfig: './babel.config.js' })],
  test: {
    globals: true,
    environment: 'jsdom' // default
  }
});
`;

  if (configPath) {
    backupFile(configPath);
    let content = fs.readFileSync(configPath, 'utf8');
    if (!content.includes("vite-plugin-babel") && !content.includes("js-sanitizer")) {
      content += `\n// Added by js-sanitizer setup\nplugins.push(babel({ babelConfig: './babel.config.js' }));\n`;
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
  console.log(`############# SETUP JS-SANITIZER #################`);

  const framework = detectTestingFramework();
  if (!framework) {
    console.log("No supported testing framework detected (jest, vitest, mocha). Skipping setup.");
    return;
  }

  ensureBabelInstalled();

  // Babel
  let babelConfigPath = findBabelConfig();
if (!babelConfigPath) {
  babelConfigPath = createDefaultBabelConfig(); 
} else {
  updateBabelConfig(babelConfigPath);
}


  checkBabelVersion();

  // Vitest
  if (framework === 'vitest') {
    updateVitestConfig();
  }

  console.log(`Detected ${framework}. Setup complete.`);
})();
