#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const configFileNames = [
  'babel.config.js',
  '.babelrc',
  '.babelrc.json'
];

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
  return path.resolve(process.cwd(), 'babel.config.js'); // default if none exists
}

function backupFile(filePath) {
  const backupPath = filePath + '.bak';
  fs.copyFileSync(filePath, backupPath);
  console.log(`Backup created: ${backupPath}`);
}

function updateBabelConfig(filePath) {
  let config = {};

  if (fs.existsSync(filePath)) {
    // Backup first
    backupFile(filePath);

    if (filePath.endsWith('.js')) {
      console.log(`Detected .js config (${filePath}). Manual addition may be required.`);
      return; // skip automatic editing for .js files to avoid breaking functions
    } else {
      config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  }

  config.plugins = config.plugins || [];
  if (!config.plugins.includes("sanitize-tests")) {
    config.plugins.push("sanitize-tests");
    console.log(`Added "sanitize-tests" plugin to ${path.basename(filePath)}`);
  }

  if (config.comments !== true) {
    config.comments = true;
    console.log(`Set comments = true in ${path.basename(filePath)}`);
  }

  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf8');
}

(function main() {
  const framework = detectTestingFramework();
  if (!framework) {
    console.log("No supported testing framework detected (jest, vitest, mocha). Skipping setup.");
    return;
  }

  const babelConfigPath = findBabelConfig();
  updateBabelConfig(babelConfigPath);

  console.log(`Detected ${framework}. Babel config updated with sanitize-tests plugin.`);
})();
