# Babel Plugin: Sanitize Tests

Automatically skip or enable JavaScript tests based on environment conditions such as OS, Node version, or browser.  
Works with **Jest**, **Mocha**, and **Vitest**.


## Installation

Install via GitHub URL:

```bash
npm install --save-dev https://github.com/Negar-Hashemi/js-sanitizer.git
```


## Features

- Skip or enable tests conditionally:
  - `@skipOnOS`, `@enabledOnOS`
  - `@skipOnNodeVersion`, `@enabledOnNodeVersion`
  - `@skipForNodeRange`, `@enabledForNodeRange`
  - `@skipOnBrowser`, `@enableOnBrowser` (works in browser-like environments)
- Works automatically with Babel using a **postinstall setup**.
- Console logs skipped tests for visibility.


## Example package.json for your project
```bash
{
  "name": "test-project",
  "version": "1.0.0",
  "devDependencies": {
    "js-sanitizer": "https://github.com/Negar-Hashemi/js-sanitizer.git"
  }
}
```


## Write annotated tests 
Add docblock comments immediately above your test blocks to control skipping behavior.

Example:

```bash
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

```

## Supported Annotations

| Annotation                     | Description                                      | Example                                   |
|--------------------------------|-------------------------------------------------|-------------------------------------------|
| `@skipOnOS <os>`               | Skip test on specific OS (`win32`, `darwin`, `linux`) | `@skipOnOS win32,darwin`                         |
| `@enabledOnOS <os>`            | Only run test on specified OS                   | `@enabledOnOS darwin`                     |
| `@skipOnNodeVersion <v>`       | Skip test on specific Node version              | `@skipOnNodeVersion 18,20`                   |
| `@enabledOnNodeVersion <v>`    | Only run test on specified Node version        | `@enabledOnNodeVersion 20`                |
| `@skipForNodeRange min=x,max=y`| Skip test if Node version is in the given range| `@skipForNodeRange min=16,max=18`        |
| `@enabledForNodeRange min=x,max=y` | Only run test if Node version is outside the range | `@enabledForNodeRange min=14,max=16` |
| `@skipOnBrowser <browser>`     | Skip test in specified browser (`Chrome`, `Firefox`, `Safari`, `Edge`) | `@skipOnBrowser Chrome` |
| `@enableOnBrowser <browser>`   | Only run test in specified browser             | `@enableOnBrowser Firefox`                |



## Logs of skipped tests
During test execution, skipped tests will log messages like:

```bash
[SKIPPING] test("sanitized test") in /path/to/file.js due to @disabledOnOS darwin,win32
```

## Notes

- Browser detection works if a browser-like environment is available (e.g., `jsdom` in Vitest).  
- Node and OS detection always work in Node.js environments.  
- Skipped tests and warnings are saved in `sanitize-tests.log` with timestamps for easy review.
