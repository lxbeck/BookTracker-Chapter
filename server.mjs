#!/usr/bin/env node
/**
 * Chapter's optional sync server.
 *
 * The app works perfectly well as static files — that's the default, and the
 * library lives in the browser. But localStorage is scoped to one browser on
 * one device, so "open it on my phone" cannot be solved in the browser at all.
 * This adds the missing piece: one shared copy of the library on the machine
 * running the server, which every device on the network reads and writes.
 *
 * Still no dependencies. Node's own http, fs and fetch are enough, and a
 * package.json full of middleware would be a strange thing to inflict on a
 * project whose whole premise is that it has no build step.
 *
 *   node server.mjs            # port 8080
 *   node server.mjs --port 3000
 *
 * Data lives in ./data — library.json plus one file per cached cover.
 */

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, extname, normalize, resolve } from 'node:path';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';

import { mergeLibraries, libraryRevision } from './js/data/merge.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const DATA_DIR = join(ROOT, 'data');
const COVER_DIR = join(DATA_DIR, 'covers');
const LIBRARY_FILE = join(DATA_DIR, 'library.json');

const PORT = Number(argValue('--port') ?? process.env.PORT ?? 8080);
const MAX_BODY = 12 * 1024 * 1024;

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index > -1 ? process.argv[index + 1] : null;
}

/* --- Library state --------------------------------------------------------- */

let library = { books: [], settings: {}, deleted: [], settingsUpdatedAt: undefined };
let revision = '0';

/** Writes are serialised through one promise so two devices can't interleave. */
let writeChain = Promise.resolve();

async function loadLibrary() {
  try {
    const raw = await readFile(LIBRARY_FILE, 'utf8');
    library = JSON.parse(raw);
    library.books ??= [];
    library.deleted ??= [];
    library.settings ??= {};
    revision = libraryRevision(library);
    console.log(`  loaded ${library.books.length} books from data/library.json`);
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('  could not read library.json:', error.message);
  }
}

function saveLibrary() {
  writeChain = writeChain.then(async () => {
    await mkdir(DATA_DIR, { recursive: true });
    // Write to a temp file and rename: a crash mid-write must not leave a
    // truncated library.json where the only copy of someone's data used to be.
    const temp = `${LIBRARY_FILE}.tmp`;
    await writeFile(temp, JSON.stringify(library, null, 2), 'utf8');
    const { rename } = await import('node:fs/promises');
    await rename(temp, LIBRARY_FILE);
  }).catch((error) => console.error('  write failed:', error.message));
  return writeChain;
}

/* --- Change stream --------------------------------------------------------- */

/** @type {Set<import('node:http').ServerResponse>} */
const listeners = new Set();

function broadcast() {
  const payload = `data: ${JSON.stringify({ revision })}\n\n`;
  for (const response of listeners) {
    try {
      response.write(payload);
    } catch {
      listeners.delete(response);
    }
  }
}

/* --- Covers ---------------------------------------------------------------- */

const EXT_BY_TYPE = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

/**
 * Fetch a cover once, server-side, and keep the bytes.
 *
 * This is the reason covers actually work here: the browser can't store an
 * image from a host that sends no CORS headers, and most cover hosts don't.
 * The server has no such restriction, so it fetches once and every device
 * gets the image from us afterwards — including offline ones, and including
 * the phone that never had the original URL work in the first place.
 */
async function storeCover(bookId, url) {
  if (!/^https?:\/\//.test(url)) throw new Error('Only http(s) cover URLs can be stored.');

  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Source returned ${response.status}`);

  const type = (response.headers.get('content-type') ?? '').split(';')[0].trim();
  const extension = EXT_BY_TYPE[type];
  if (!extension) throw new Error(`Not an image (${type || 'unknown type'})`);

  const buffer = Buffer.from(await response.arrayBuffer());
  // Open Library answers a missing cover with a 1-pixel placeholder rather
  // than a 404; anything this small is not a book cover.
  if (buffer.byteLength < 1024) throw new Error('Source returned a placeholder image');

  await mkdir(COVER_DIR, { recursive: true });
  await writeFile(join(COVER_DIR, safeId(bookId) + extension), buffer);
  return { bytes: buffer.byteLength, type };
}

async function findCover(bookId) {
  const id = safeId(bookId);
  for (const extension of ['.jpg', '.png', '.webp', '.gif']) {
    const path = join(COVER_DIR, id + extension);
    try {
      await stat(path);
      return { path, type: Object.keys(EXT_BY_TYPE).find((k) => EXT_BY_TYPE[k] === extension) };
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/** Ids come from the network, so they never touch the filesystem unfiltered. */
const safeId = (id) => String(id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);

/* --- HTTP ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const json = (response, status, body) => {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
};

function readBody(request) {
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('Body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);

  // Same-origin in practice, but a phone on the LAN is a different host, and
  // the app may be opened from a bookmarked IP.
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-methods', 'GET,PUT,POST,OPTIONS');
  response.setHeader('access-control-allow-headers', 'content-type');
  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }

  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(request, response, url);
      return;
    }
    await serveStatic(request, response, url);
  } catch (error) {
    console.error('  request failed:', error.message);
    if (!response.headersSent) json(response, 500, { error: error.message });
    else response.end();
  }
});

async function handleApi(request, response, url) {
  /* Health check — how the client decides whether it's in synced mode. */
  if (url.pathname === '/api/status') {
    json(response, 200, {
      ok: true,
      revision,
      books: library.books.length,
      storage: 'server',
    });
    return;
  }

  if (url.pathname === '/api/library' && request.method === 'GET') {
    json(response, 200, { ...library, revision });
    return;
  }

  /* A device pushes its copy; the server merges rather than overwrites, so a
     stale phone can never wipe work done elsewhere. */
  if (url.pathname === '/api/library' && request.method === 'PUT') {
    const incoming = JSON.parse(await readBody(request));
    const { state, changed } = mergeLibraries(library, incoming);
    library = state;
    const next = libraryRevision(library);

    if (changed || next !== revision) {
      revision = next;
      await saveLibrary();
      broadcast();
    }
    json(response, 200, { ...library, revision });
    return;
  }

  /* Server-sent events: every other device hears about a change immediately
     instead of polling on a timer. */
  if (url.pathname === '/api/events') {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    response.write(`data: ${JSON.stringify({ revision })}\n\n`);
    listeners.add(response);

    // Proxies and phone radios drop idle connections; a comment every 25
    // seconds keeps the stream alive without sending a spurious change.
    const keepAlive = setInterval(() => {
      try {
        response.write(': keep-alive\n\n');
      } catch {
        clearInterval(keepAlive);
      }
    }, 25000);

    request.on('close', () => {
      clearInterval(keepAlive);
      listeners.delete(response);
    });
    return;
  }

  const coverMatch = url.pathname.match(/^\/api\/covers\/([^/]+)$/);
  if (coverMatch) {
    const bookId = decodeURIComponent(coverMatch[1]);

    if (request.method === 'POST') {
      const { url: source } = JSON.parse(await readBody(request));
      try {
        const result = await storeCover(bookId, source);
        json(response, 200, { ok: true, ...result });
      } catch (error) {
        json(response, 200, { ok: false, error: error.message });
      }
      return;
    }

    const found = await findCover(bookId);
    if (!found) {
      json(response, 404, { error: 'No stored cover for that book.' });
      return;
    }
    response.writeHead(200, {
      'content-type': found.type,
      'cache-control': 'public, max-age=604800',
    });
    createReadStream(found.path).pipe(response);
    return;
  }

  if (url.pathname === '/api/covers') {
    const files = await readdir(COVER_DIR).catch(() => []);
    let bytes = 0;
    for (const file of files) {
      const info = await stat(join(COVER_DIR, file)).catch(() => null);
      bytes += info?.size ?? 0;
    }
    json(response, 200, {
      count: files.length,
      bytes,
      ids: files.map((file) => file.replace(extname(file), '')),
    });
    return;
  }

  json(response, 404, { error: 'Unknown endpoint.' });
}

async function serveStatic(request, response, url) {
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  // normalize + prefix check keeps `../../etc/passwd` inside the project.
  const path = resolve(join(ROOT, normalize(decodeURIComponent(requested))));

  if (!path.startsWith(resolve(ROOT))) {
    json(response, 403, { error: 'Forbidden' });
    return;
  }

  try {
    const info = await stat(path);
    if (info.isDirectory()) throw Object.assign(new Error('directory'), { code: 'ENOENT' });

    response.writeHead(200, {
      'content-type': MIME[extname(path)] ?? 'application/octet-stream',
      // The shell must not be cached by the browser, or an edit appears to do
      // nothing until a hard reload. Covers are immutable and cached above.
      'cache-control': 'no-cache',
    });
    createReadStream(path).pipe(response);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
}

/* --- Boot ------------------------------------------------------------------ */

function localAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address);
}

await loadLibrary();

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  Chapter is running.\n');
  console.log(`  This machine:  http://localhost:${PORT}`);
  for (const address of localAddresses()) {
    console.log(`  Other devices: http://${address}:${PORT}`);
  }
  console.log('\n  Library and covers are stored in ./data\n');
});
