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

function updateJsBabelConfig(filePath) {
  backupFile(filePath);

  let content = fs.readFileSync(filePath, 'utf8');

  // Add plugin entry if not present
  if (!content.includes('"js-sanitizer"') && !content.includes("'js-sanitizer'")) {
    const pluginInsertRegex = /(plugins\s*:\s*\[)([^]*?)(\])/m;
    if (pluginInsertRegex.test(content)) {
      content = content.replace(pluginInsertRegex, (_, start, existing, end) => {
        const newPlugins = existing.trim().length ? existing.trim() + ', "js-sanitizer"' : '"js-sanitizer"';
        return `${start}${newPlugins}${end}`;
      });
    } else {
      const moduleExportsRegex = /module\.exports\s*=\s*{([^]*?)}/m;
      if (moduleExportsRegex.test(content)) {
        content = content.replace(moduleExportsRegex, (_, body) => {
          return `module.exports = {${body.trim()},\n  plugins: ["js-sanitizer"],\n  comments: true\n}`;
        });
      } else {
        console.log(`Cannot automatically edit ${filePath}. Please add "js-sanitizer" manually.`);
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
  if (!config.plugins.includes("js-sanitizer")) {
    config.plugins.push("js-sanitizer");
    console.log(`Added "js-sanitizer" plugin to ${path.basename(filePath)}`);
  }
  config.comments = true;
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf8');
}

function updateBabelConfig(filePath) {
  if (filePath.endsWith('.js')) {
    updateJsBabelConfig(filePath);
  } else {
    updateJsonBabelConfig(filePath);
  }
}

(function main() {
  const framework = detectTestingFramework();
  if (!framework) {
    console.log("No supported testing framework detected (jest, vitest, mocha). Skipping setup.");
    return;
  }

  const babelConfigPath = findBabelConfig();
  updateBabelConfig(babelConfigPath);

  console.log(`Detected ${framework}. Babel config updated with "js-sanitizer" plugin.`);
})();
