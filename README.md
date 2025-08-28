# Babel Plugin: Sanitize Tests

Automatically skip or enable JavaScript tests based on environment conditions such as OS, Node version, or browser.  
Works with **Jest**, **Mocha**, and **Vitest**.

---

## Installation

### If `js-sanitizer` is not in your package.json
Add it as a dev dependency:
```bash
npm install --save-dev git+https://github.com/Negar-Hashemi/js-sanitizer.git
```

### If `js-sanitizer` is already in your package.json
Simply install dependencies:
```bash
npm install
```

In both cases, the `setup.js` script will run automatically (via `postinstall`) and configure Babel + your test framework.

---

## Features

- Skip or enable tests conditionally with simple **docblock annotations**:
  - `@skipOnOS`, `@enabledOnOS`
  - `@skipOnNodeVersion`, `@enabledOnNodeVersion`
  - `@skipForNodeRange`, `@enabledForNodeRange`
  - `@skipOnBrowser`, `@enabledOnBrowser` (works in browser-like environments)
- Works automatically with Babel using the **postinstall setup**.
- Logs all skipped tests to console **and** `sanitize-tests.log`.

---

## Example package.json

```json
{
  "name": "test-project",
  "version": "1.0.0",
  "devDependencies": {
    "js-sanitizer": "git+https://github.com/Negar-Hashemi/js-sanitizer.git"
  }
}
```

---

## Writing Annotated Tests

Add docblock comments immediately above your test blocks to control skipping behavior:

```js
/**
 * @skipOnOS win32
 */
test('This test is skipped on Windows', () => {
  expect(true).toBe(true);
});

/**
 * @enabledOnNodeVersion 18
 */
it('Runs only on Node 18', () => {
  expect(1 + 1).toBe(2);
});

/**
 * @skipOnBrowser Chrome
 */
describe('Skip on Chrome', () => {
  test('should not run on Chrome', () => {});
});

/**
 * @enabledOnBrowser Firefox
 */
test('Only runs on Firefox', () => {
  expect(true).toBe(true);
});
```

---

## Supported Annotations

| Annotation                        | Description                                        | Example                                    |
|-----------------------------------|----------------------------------------------------|--------------------------------------------|
| `@skipOnOS <os>`                  | Skip test on specific OS (`win32`, `darwin`, `linux`) | `@skipOnOS win32,darwin`                  |
| `@enabledOnOS <os>`               | Only run test on specified OS                      | `@enabledOnOS darwin`                      |
| `@skipOnNodeVersion <v>`          | Skip test on specific Node version                 | `@skipOnNodeVersion 18,20`                 |
| `@enabledOnNodeVersion <v>`       | Only run test on specified Node version            | `@enabledOnNodeVersion 20`                 |
| `@skipForNodeRange min=x,max=y`   | Skip test if Node version is in the given range    | `@skipForNodeRange min=16,max=18`          |
| `@enabledForNodeRange min=x,max=y`| Only run test if Node version is outside the range | `@enabledForNodeRange min=14,max=16`       |
| `@skipOnBrowser <browser>`        | Skip test in specified browser (`Chrome`, `Firefox`, `Safari`, `Edge`) | `@skipOnBrowser Chrome` |
| `@enabledOnBrowser <browser>`     | Only run test in specified browser                 | `@enabledOnBrowser Firefox`                |

---

## Supported Frameworks

The plugin works with **Jest**, **Mocha**, and **Vitest**.  
The `setup.js` script automatically configures the correct integration:

### Jest
- Ensures Babel is active using `babel-jest`.
- If no Jest config exists, creates a minimal `jest.config.js`.
- If you already have a Jest config, it won’t overwrite it — just make sure `transform` includes `babel-jest`.

### Mocha
- Creates a `babel.register.js` file to hook Babel into Mocha.
- Updates/creates `.mocharc.json` to require `./babel.register.js`.

### Vitest
- Creates `vitest.setup.js` to register Babel before tests run.
- Updates your `package.json` to include this file under `vitest.setupFiles`.

---

# js-sanitizer: Framework Integration

The plugin works with **Jest**, **Mocha**, and **Vitest**.

---

## What `setup.js` Does Automatically

### Jest
- Detects Jest (dependency or `scripts.test`).
- Ensures **Babel** is active via `babel-jest` (or `ts-jest` with a Babel pass).
- If no config exists, creates a minimal `jest.config.js`.
- If a config exists, it won’t overwrite it; just make sure:
  - `transform` includes `babel-jest`, **or**
  - `ts-jest` has `globals['ts-jest'].babelConfig = true`.
- Ensures `@babel/preset-env` is present.  
  Adds `@babel/preset-typescript` if the project uses TypeScript.

### Mocha
- Generates `babel.register.js` to hook Babel at runtime (tests only).
- Adds `--require ./babel.register.js`:
  - For Mocha ≥ 6: updates/creates `.mocharc.json`.
  - For older Mocha: updates/creates `mocha.opts`.
- Ensures `jest-docblock` (for tag parsing) and `@babel/register` are available.
- Ensures `@babel/preset-env` and (if TS present) `@babel/preset-typescript`.

### Vitest
- Creates `vitest.setup.js` so a setup file always exists.
- Adds `vitest.setupFiles` to your `package.json` (non-destructive merge).
- If the workspace runs Vitest, enables `vite-plugin-babel` so Babel plugins (like `module:js-sanitizer`) run on test files.
- Does **not** overwrite existing `vitest.config.ts` / `vitest.config.*`.
- Ensures `@babel/preset-env` and (if TS present) `@babel/preset-typescript`.

---

## Manual Setup

If you don’t want to run `setup.js`, here’s how to set things up yourself.

### Common Prerequisites

Install Babel core + presets (and TS preset if your tests are TypeScript):

```bash
npm i -D @babel/core @babel/preset-env @babel/preset-typescript
```

Create a Babel config:

```js
// babel.config.js (or .cjs / .babelrc)
module.exports = {
  presets: [
    ["@babel/preset-env", { targets: { node: "current" }, modules: false }],
    ["@babel/preset-typescript", { allowDeclareFields: true }] // if using TypeScript
  ],
  plugins: ["module:js-sanitizer"],
  comments: true
};
```

---

### Jest (Manual)

Install a transformer:

```bash
# For JS projects:
npm i -D babel-jest

# For TS projects already using ts-jest:
npm i -D ts-jest
```

Config options:

```js
// jest.config.js (JS projects)
module.exports = {
  testEnvironment: 'node',
  transform: { '^.+\.[jt]sx?$': 'babel-jest' },
};
```

```js
// jest.config.js (TS projects with ts-jest)
module.exports = {
  testEnvironment: 'node',
  transform: { '^.+\.ts$': 'ts-jest' },
  globals: { 'ts-jest': { babelConfig: true } },
};
```

---

### Mocha (Manual)

Install runtime hook:

```bash
npm i -D @babel/register jest-docblock
```

Create `babel.register.js`:

```js
// babel.register.js
require('@babel/register')({
  extensions: ['.js', '.jsx', '.ts', '.tsx'],
  cache: true,
  babelrc: true,
  configFile: true,
});
```

Tell Mocha to require it:

- **Mocha ≥ 6**: `.mocharc.json`
  ```json
  { "require": ["./babel.register.js"] }
  ```
- **Older Mocha**: `mocha.opts`
  ```
  --require ./babel.register.js
  ```

---

### Vitest (Manual)

Install the Vite plugin:

```bash
npm i -D vite-plugin-babel
```

Configure Vitest:

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config'
import babel from 'vite-plugin-babel'

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./vitest.setup.js'],
  },
  plugins: [
    babel({
      filter: /\.(test|spec)\.(js|ts|jsx|tsx)$/,
      babelConfig: { configFile: true, babelrc: true },
    }),
  ],
})
```

Create `vitest.setup.js` (can be empty):

```js
// vitest.setup.js
// optional: globals/mocks
// DO NOT call @babel/register here (vite-plugin-babel already handles Babel)
```

---

## Notes & Gotchas

- **Monorepos / workspaces**: if tests run from a workspace without a local `vitest` dep, still create `vitest.setup.js` in that workspace and reference it in `package.json` or `vitest.config.*`.  
- **Windows CI**: if tests write to `D:\tmp\…`, create the directory first:
  ```pwsh
  New-Item -ItemType Directory -Path 'D:\tmp' -Force | Out-Null
  ```
- Do **not** mix `@babel/register` with Vitest’s `vite-plugin-babel` — that can cause double transforms.  
- For TypeScript tests, include `@babel/preset-typescript` so your Babel plugins also apply to `.ts` tests.


## Logs of Skipped Tests

During test execution, skipped tests will log messages like:

```bash
[SKIPPING] test("sanitized test") in /path/to/file.js due to @enabledOnOS darwin
```

Additionally, all skipped test decisions are written to `sanitize-tests.log` with timestamps:

```
[2025-08-17T10:42:00.123Z] [SKIPPING] test("Example") in src/foo.test.js due to @skipOnNodeVersion 18
```

---

## Notes

- **Browser detection** works if a browser-like environment is available (e.g., `jsdom` in Jest or Vitest).  
- **Node.js and OS detection** always work in Node.js environments.  
- Use the `JS_SANITIZER_BROWSER` environment variable in CI to explicitly set a browser name (`Chrome`, `Firefox`, `Safari`, `Edge`).  
- Skipped tests and warnings are logged both to the console and to `sanitize-tests.log`.

---
