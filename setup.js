#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const configFileNames = [
  'babel.config.js',
  '.babelrc',
  '.babelrc.json'
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
    if (!fs.existsSync(backupPath)) {
      fs.copyFileSync(filePath, backupPath);
      console.log(`Backup created: ${backupPath}`);
    }
  }
}

// ------------------ Babel Config ------------------

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
  console.log(`Created default Babel config: ${path.basename(filePath)} with js-sanitizer plugin.`);
}

function updateJsBabelConfig(filePath) {
  backupFile(filePath);
  let content = fs.readFileSync(filePath, 'utf8');

  if (!content.includes('"js-sanitizer"') && !content.includes("'js-sanitizer'")) {
    const pluginInsertRegex = /(plugins\s*:\s*\[)([^]*?)(\])/m;
    if (pluginInsertRegex.test(content)) {
      content = content.replace(pluginInsertRegex, (_, start, existing, end) => {
        const trimmed = existing.trim();
        const newPlugins = trimmed.length ? trimmed + ', "module:js-sanitizer"' : '"module:js-sanitizer"';
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

// ------------------ Vitest Config ------------------

function setupVitestConfig() {
  const hostRoot = process.cwd();
  const viteConfigPath = path.join(hostRoot, 'vite.config.js');

  // Ensure vite-plugin-babel is installed
  try {
    require.resolve('vite-plugin-babel');
  } catch (err) {
    console.log('Installing vite-plugin-babel...');
    execSync('npm install --save-dev vite-plugin-babel', { stdio: 'inherit' });
  }

  let configContent = '';
  const babelPluginImport = `import babel from 'vite-plugin-babel';`;

  if (fs.existsSync(viteConfigPath)) {
    configContent = fs.readFileSync(viteConfigPath, 'utf8');

    if (!configContent.includes('vite-plugin-babel')) {
      configContent = `${babelPluginImport}\n${configContent}`;
    }

    if (!/plugins\s*:\s*\[.*babel.*\]/s.test(configContent)) {
      configContent = configContent.replace(/plugins\s*:\s*\[([^\]]*)\]/s, (match, inner) => {
        const newInner = inner.trim().length ? inner + ', babel({ babelConfig: "./babel.config.js" })' : 'babel({ babelConfig: "./babel.config.js" })';
        return `plugins: [${newInner}]`;
      });
    }

    fs.writeFileSync(viteConfigPath, configContent, 'utf8');
    console.log('Updated existing vite.config.js with Babel plugin for Vitest');
  } else {
    const newConfig = `
import { defineConfig } from 'vite';
import babel from 'vite-plugin-babel';

export default defineConfig({
  plugins: [babel({ babelConfig: './babel.config.js' })],
  test: {
    globals: true,
    environment: 'jsdom'
  }
});
`;
    fs.writeFileSync(viteConfigPath, newConfig.trim(), 'utf8');
    console.log('Created vite.config.js with Babel plugin for Vitest');
  }
}

// ------------------ Main ------------------

(function main() {
  
  const framework = detectTestingFramework();
  if (!framework) {
    console.log("No supported testing framework detected (jest, vitest, mocha). Skipping setup.");
    return;
  }

  console.log("##########"+framework+"############")

  const babelConfigPath = findBabelConfig();
  updateBabelConfig(babelConfigPath);

  checkBabelVersion();

  if (framework === 'vitest') {
    setupVitestConfig();
  }

  console.log(`Detected ${framework}. Babel config updated with "js-sanitizer" plugin.`);
})();
