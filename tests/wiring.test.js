/**
 * Is every function a module calls actually there?
 *
 * This exists because the settings page shipped broken twice. A refactor
 * replaced a range of one file and took six functions with it that were still
 * being called at the top of `renderSettings` — so the module parsed, loaded,
 * imported cleanly, passed every data-layer test, and threw
 * `appearanceSection is not defined` the moment anyone opened the tab. The
 * page went blank and the router left the previous view on screen.
 *
 * Nothing else here could catch it. `node --check` only parses. The import
 * audit checks names crossing module boundaries, and these calls did not cross
 * one. The data-layer tests never render a view, because rendering needs a DOM.
 *
 * So the source is read as text and every called name is resolved against what
 * the module defines, imports, or can expect from the browser. Crude, and it
 * catches exactly the class of mistake that took a whole view down.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Comments and strings are prose; they must not be read as code. */
function stripNonCode(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1')
    .replace(/`(?:[^`\\]|\\[\s\S])*`/g, '``')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

function sourceFiles() {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.js')) found.push(path);
    }
  };
  walk(join(ROOT, 'js'));
  return found;
}

/** Everything a module declares under its own roof. */
function declaredIn(code) {
  const names = new Set();

  const add = (pattern, group = 1) => {
    for (const match of code.matchAll(pattern)) names.add(match[group]);
  };

  add(/(?:^|\s)(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g);
  add(/(?:^|\s)(?:export\s+)?(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/g);

  // Imported bindings, including default and namespace imports.
  for (const match of code.matchAll(/import\s+([^;]*?)\s+from\s+/g)) {
    const clause = match[1];
    const braced = /\{([^}]*)\}/.exec(clause);
    if (braced) {
      for (const part of braced[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (name) names.add(name);
      }
    }
    const bare = clause.replace(/\{[^}]*\}/, '').replace(/\*\s+as\s+/, '').replace(/,/g, '').trim();
    if (bare) names.add(bare);
  }

  // Anything bound as a parameter or destructured is in scope somewhere; this
  // check is about module-level functions, so being generous here only avoids
  // false alarms.
  add(/(?:const|let|var)\s*\{([^}]*)\}/g);
  for (const match of code.matchAll(/(?:const|let|var)\s*\{([^}]*)\}/g)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split(':').pop().trim().replace(/\s*=.*$/, '');
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  for (const match of code.matchAll(/\(([^)]*)\)\s*=>/g)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().replace(/\s*=.*$/, '').replace(/^\.\.\./, '');
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  for (const match of code.matchAll(/function\s*[A-Za-z_$\w]*\s*\(([^)]*)\)/g)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().replace(/\s*=.*$/, '').replace(/^\.\.\./, '');
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  for (const match of code.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)/g)) names.add(match[1]);

  return names;
}

/** Things the browser and the language supply. */
const AMBIENT = new Set([
  'window', 'document', 'console', 'fetch', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'requestAnimationFrame', 'queueMicrotask',
  'Promise', 'Array', 'Object', 'String', 'Number', 'Boolean', 'Math', 'JSON',
  'Date', 'Map', 'Set', 'WeakMap', 'RegExp', 'Error', 'Symbol', 'Intl',
  'Image', 'Blob', 'File', 'FileReader', 'URL', 'URLSearchParams', 'FormData',
  'AbortController', 'TextEncoder', 'TextDecoder', 'CustomEvent', 'Event',
  'IntersectionObserver', 'ResizeObserver', 'MutationObserver', 'Node',
  'localStorage', 'sessionStorage', 'indexedDB', 'navigator', 'location',
  'alert', 'confirm', 'prompt', 'structuredClone', 'isNaN', 'parseInt',
  'parseFloat', 'encodeURIComponent', 'decodeURIComponent', 'Uint8Array',
  'ArrayBuffer', 'Infinity', 'NaN', 'undefined', 'globalThis', 'self',
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'await',
  'super', 'this', 'new', 'function', 'else', 'do', 'try', 'constructor',
]);

const FILES = sourceFiles();

test('there are modules to check', () => {
  assert.ok(FILES.length > 20);
});

/**
 * The body of a module's exported render function.
 *
 * Deliberately just this, rather than every call in the file: a render
 * function is a list of the things a view is made of, written at the top level
 * of its own module, and that is exactly where the missing pieces were. A
 * whole-file scan drowns in false positives — object-literal method shorthand,
 * destructured parameters, promise callbacks — and a check nobody trusts is a
 * check nobody reads.
 */
function renderBodies(code) {
  const bodies = [];

  for (const match of code.matchAll(/export function (render[A-Za-z]*)\s*\(/g)) {
    const from = match.index;
    let depth = 0;
    let started = false;

    for (let at = from; at < code.length; at += 1) {
      if (code[at] === '{') {
        depth += 1;
        started = true;
      } else if (code[at] === '}') {
        depth -= 1;
        if (started && depth === 0) {
          bodies.push({ name: match[1], body: code.slice(from, at) });
          break;
        }
      }
    }
  }

  return bodies;
}

test('every view renders from pieces that exist', () => {
  // The bug this is for: a refactor replaced a range of settings.js and took
  // six section builders with it, while renderSettings went on calling all
  // six. The module parsed, imported cleanly, passed every other test, and
  // threw the moment the tab was opened — leaving the page blank and the
  // router showing the previous view.
  const broken = [];

  for (const file of FILES.filter((path) => path.includes('/views/'))) {
    const code = stripNonCode(readFileSync(file, 'utf8'));
    const declared = declaredIn(code);

    for (const { name, body } of renderBodies(code)) {
      for (const match of body.matchAll(/(^|[^\w$.?])([a-z_$][\w$]*)\s*\(/g)) {
        const called = match[2];
        if (declared.has(called) || AMBIENT.has(called)) continue;
        broken.push(`${file.slice(ROOT.length)}: ${name}() calls ${called}(), which is not there`);
      }
    }
  }

  assert.deepEqual([...new Set(broken)], []);
});

test('every view module still defines the sections its render calls', () => {
  // The specific shape of the bug: a render function listing section builders
  // that a refactor had removed from the same file.
  const settings = stripNonCode(readFileSync(join(ROOT, 'js/views/settings.js'), 'utf8'));
  const declared = declaredIn(settings);

  const render = settings.slice(settings.indexOf('export function renderSettings'));
  const body = render.slice(0, render.indexOf('\n}'));

  const called = [...body.matchAll(/(^|[^\w$.])([a-z][\w$]*Section)\s*\(/g)].map((m) => m[2]);

  assert.ok(called.length > 5, 'renderSettings should be assembling several sections');
  for (const name of called) {
    assert.ok(declared.has(name), `renderSettings calls ${name}(), which no longer exists`);
  }
});

test('the app registers a render for every route it links to', () => {
  const app = stripNonCode(readFileSync(join(ROOT, 'js/app.js'), 'utf8'));
  const routes = [...app.matchAll(/^\s*([a-z]+):\s*\{\s*label:/gm)].map((match) => match[1]);

  assert.ok(routes.length >= 5, `expected the view table, found ${routes.length}`);

  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  for (const match of html.matchAll(/href="#\/([a-z]+)"/g)) {
    assert.ok(routes.includes(match[1]), `the page links to #/${match[1]}, which has no view`);
  }
});
