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

function findBabelConfig() {
  for (const file of configFileNames) {
    const fullPath = path.resolve(process.cwd(), file);
    if (fs.existsSync(fullPath)) return fullPath;
  }
  return path.resolve(process.cwd(), 'babel.config.js'); // default for new config
}

function backupFile(filePath) {
  if (fs.existsSync(filePath)) {
    const backupPath = filePath + '.bak';
    fs.copyFileSync(filePath, backupPath);
    console.log(`Backup created: ${backupPath}`);
  }
}

function createDefaultBabelConfig(filePath) {
  const content = `module.exports = {
  presets: [
    ["@babel/preset-env", { targets: { node: "current" } }]
  ],
  plugins: ["module:js-sanitizer"],
  comments: true
};
`;
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`No Babel config found. Created default ${path.basename(filePath)} with js-sanitizer plugin.`);
}

function updateJsBabelConfig(filePath) {
  backupFile(filePath);
  let content = fs.readFileSync(filePath, 'utf8');

  if (!content.includes('"js-sanitizer"') && !content.includes("'js-sanitizer'")) {
    const pluginInsertRegex = /(plugins\s*:\s*\[)([^]*?)(\])/m;
    if (pluginInsertRegex.test(content)) {
      content = content.replace(pluginInsertRegex, (_, start, existing, end) => {
        const newPlugins = existing.trim().length ? existing.trim() + ', "module:js-sanitizer"' : '"module:js-sanitizer"';
        return `${start}${newPlugins}${end}`;
      });
    } else {
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

  if (!/comments\s*:\s*true/.test(content)) {
    content = content.replace(/module\.exports\s*=\s*{/, "module.exports = {\n  comments: true,");
  }

  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`Updated Babel JS config: ${filePath}`);
}

function updateJsonBabelConfig(filePath) {
  backupFile(filePath);
  let config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  config.plugins = config.plugins || [];
  if (!config.plugins.includes("module:js-sanitizer")) {
    config.plugins.push("module:js-sanitizer");
    console.log(`Added "js-sanitizer" plugin to ${path.basename(filePath)}`);
  }
  config.comments = true;
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf8');
}

function updateBabelConfig(filePath) {
  if (!fs.existsSync(filePath)) {
    createDefaultBabelConfig(filePath);
    return;
  }

  if (filePath.endsWith('.js')) {
    updateJsBabelConfig(filePath);
  } else {
    updateJsonBabelConfig(filePath);
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

  const [major, minor, patch] = versionMatch[0].split('.').map(Number);
  const needsUpdate =
    major < MIN_BABEL_VERSION[0] ||
    (major === MIN_BABEL_VERSION[0] && minor < MIN_BABEL_VERSION[1]);

  if (needsUpdate) {
    console.warn(`[WARNING] Your @babel/core version (${versionMatch[0]}) is too old. Please update to >= ${MIN_BABEL_VERSION.join('.')}`);
    try {
      console.log("Attempting to update @babel/core and @babel/preset-env automatically...");
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

  const babelConfigPath = findBabelConfig();
  updateBabelConfig(babelConfigPath);

  checkBabelVersion();

  console.log(`Detected ${framework}. Babel config updated with "js-sanitizer" plugin.`);
})();
