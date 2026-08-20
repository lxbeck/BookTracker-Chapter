/**
 * Does every import actually exist?
 *
 * With no build step there is nothing between a typo and a blank screen. A
 * misspelled import is valid JavaScript that parses, loads, and throws only
 * when the browser reaches the line — which for a rarely opened dialog can be
 * weeks later. Most of these modules touch `document` at import time, so the
 * test suite cannot simply load them and find out.
 *
 * So the source is read as text and the two halves are compared: every name a
 * module imports must be a name the target module exports. Crude, and it
 * catches the exact class of mistake that no other test here can.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SOURCE_DIRS = ['js'];

/** Every .js file under the source directories, and the server. */
function sourceFiles() {
  const found = [];

  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith('.js')) found.push(path);
    }
  };

  for (const dir of SOURCE_DIRS) walk(join(ROOT, dir));
  found.push(join(ROOT, 'server.mjs'));
  found.push(join(ROOT, 'sw.js'));
  return found;
}

/**
 * The source with its comments removed.
 *
 * Necessary rather than tidy: this file's own explanation of an import cycle
 * contains the words "import" and "from", and a scanner that reads prose finds
 * imports in it. Stripping comments first is the difference between a check
 * and a source of false alarms.
 */
const read = (path) =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"\`])\/\/[^\n]*/g, '$1');

/**
 * Names a module makes available.
 *
 * Covers the four shapes this codebase uses: `export function x`,
 * `export const x`, `export { a, b }` and `export default`.
 */
function exportsOf(source) {
  const names = new Set();

  for (const match of source.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(match[1]);
  }
  for (const match of source.matchAll(/^export\s+(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(match[1]);
  }
  for (const match of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) names.add(name);
    }
  }
  if (/^export\s+default/m.test(source)) names.add('default');

  return names;
}

/** What a module asks for, and where from. */
function importsOf(source) {
  const found = [];

  // Anchored to the start of a line: an import is a statement, and anything
  // that looks like one mid-line is a string or a leftover.
  for (const match of source.matchAll(/^\s*import\s+([^;]*?)\s+from\s+['"]([^'"]+)['"]/gm)) {
    const [, clause, specifier] = match;
    if (!specifier.startsWith('.')) continue;

    const names = [];
    const braced = /\{([^}]*)\}/.exec(clause);
    if (braced) {
      for (const part of braced[1].split(',')) {
        const raw = part.trim();
        if (!raw) continue;
        names.push(raw.split(/\s+as\s+/)[0].trim());
      }
    }

    const bare = clause.replace(/\{[^}]*\}/, '').replace(/,/g, '').trim();
    if (bare && !bare.startsWith('*')) names.push('default');

    found.push({ specifier, names });
  }

  return found;
}

const FILES = sourceFiles();

test('every module a file imports from exists', () => {
  const missing = [];

  for (const file of FILES) {
    for (const { specifier } of importsOf(read(file))) {
      const target = resolve(dirname(file), specifier);
      try {
        statSync(target);
      } catch {
        missing.push(`${relative(ROOT, file)} imports ${specifier}, which is not there`);
      }
    }
  }

  assert.deepEqual(missing, []);
});

test('every name a file imports is exported by the module it comes from', () => {
  const broken = [];

  for (const file of FILES) {
    for (const { specifier, names } of importsOf(read(file))) {
      const target = resolve(dirname(file), specifier);
      let available;
      try {
        available = exportsOf(read(target));
      } catch {
        continue; // reported by the test above
      }

      for (const name of names) {
        if (!available.has(name)) {
          broken.push(`${relative(ROOT, file)} imports { ${name} } from ${specifier}, which does not export it`);
        }
      }
    }
  }

  assert.deepEqual(broken, []);
});

test('nothing imports a module that imports it back', () => {
  // A cycle between two modules that both run code at import time is a blank
  // screen with a confusing error, and the data layer has no reason to have one.
  const graph = new Map();

  for (const file of FILES) {
    const targets = importsOf(read(file)).map(({ specifier }) =>
      resolve(dirname(file), specifier)
    );
    graph.set(file, targets);
  }

  const cycles = [];
  for (const [file, targets] of graph) {
    for (const target of targets) {
      if (graph.get(target)?.includes(file)) {
        const pair = [relative(ROOT, file), relative(ROOT, target)].sort().join(' <-> ');
        if (!cycles.includes(pair)) cycles.push(pair);
      }
    }
  }

  assert.deepEqual(cycles, []);
});

test('no module declares the same import name twice', () => {
  // Two import statements from the same module, each pulling a name the other
  // already has, is a SyntaxError that only surfaces when the file is loaded.
  const clashes = [];

  for (const file of FILES) {
    const seen = new Set();
    for (const { names } of importsOf(read(file))) {
      for (const name of names) {
        if (name === 'default') continue;
        if (seen.has(name)) clashes.push(`${relative(ROOT, file)} imports ${name} twice`);
        seen.add(name);
      }
    }
  }

  assert.deepEqual(clashes, []);
});
