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
 *   npm start                     # port 8090
 *   npm start -- --port 3000      # anything else
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

// 8090 rather than 8080: 8080 is the default for half the tooling on a
// developer's machine, and a port clash on first run is a bad first minute.
const DEFAULT_PORT = 8090;
const PORT = Number(argValue('--port') ?? process.env.PORT ?? DEFAULT_PORT);

// Calibre stores cover.jpg next to each book; importing them means reading
// those paths. On by default because it is the point of the feature, and off
// with one flag for anyone who would rather it weren't possible.
const ALLOW_LOCAL_COVERS = !process.argv.includes('--no-local-covers');
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
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('  could not read library.json:', error.message);
      // Refuse to start on a corrupt file rather than overwriting it with an
      // empty library the moment the first device syncs.
      if (error instanceof SyntaxError) {
        console.error('  data/library.json is not valid JSON. Move it aside and restart.');
        process.exit(1);
      }
    }
    return false;
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
/**
 * Copy a cover straight off the local disk — how Calibre imports get their art.
 *
 * Reading an arbitrary path on request is a real capability, so it is fenced:
 * the path must name an image, must be a regular file, and the bytes must
 * actually start with an image signature. A caller cannot use this to read a
 * text file, and nothing is ever served back that did not pass those checks.
 * Start the server with --no-local-covers to switch it off entirely.
 */
const IMAGE_MAGIC = [
  { bytes: [0xff, 0xd8, 0xff], ext: '.jpg', type: 'image/jpeg' },
  { bytes: [0x89, 0x50, 0x4e, 0x47], ext: '.png', type: 'image/png' },
  { bytes: [0x47, 0x49, 0x46, 0x38], ext: '.gif', type: 'image/gif' },
  { bytes: [0x52, 0x49, 0x46, 0x46], ext: '.webp', type: 'image/webp' },
];

async function storeLocalCover(bookId, path) {
  if (!ALLOW_LOCAL_COVERS) throw new Error('Local cover reading is disabled on this server.');
  if (!/\.(jpe?g|png|webp|gif)$/i.test(path)) throw new Error('Not an image path.');

  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw new Error('No file at that path on the server.');
  if (info.size < 1024) throw new Error('That file is too small to be a cover.');
  if (info.size > 20 * 1024 * 1024) throw new Error('That file is too large to be a cover.');

  const buffer = await readFile(path);
  const signature = IMAGE_MAGIC.find((candidate) =>
    candidate.bytes.every((byte, index) => buffer[index] === byte)
  );
  if (!signature) throw new Error('That file is not an image.');

  await mkdir(COVER_DIR, { recursive: true });
  await writeFile(join(COVER_DIR, safeId(bookId) + signature.ext), buffer);
  return { bytes: buffer.byteLength, type: signature.type };
}

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
      localCovers: ALLOW_LOCAL_COVERS,
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
      const { url: source, path: localPath } = JSON.parse(await readBody(request));
      try {
        const result = localPath
          ? await storeLocalCover(bookId, localPath)
          : await storeCover(bookId, source);
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

const hadLibrary = await loadLibrary();

/**
 * A port clash is the single most likely thing to go wrong on first run, and
 * an unhandled 'error' event turns it into a twenty-line stack trace that
 * buries the one sentence that matters.
 */
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already being used by something else.\n`);
    console.error('  Either start Chapter on another port:');
    console.error(`      npm start -- --port ${PORT + 1}\n`);
    console.error('  Or stop whatever is holding it:');
    console.error(`      lsof -ti:${PORT} | xargs kill      (macOS, Linux)`);
    console.error(`      npx kill-port ${PORT}               (any platform)\n`);
    process.exit(1);
  }

  if (error.code === 'EACCES') {
    console.error(`\n  Not allowed to listen on port ${PORT}. Ports below 1024 need`);
    console.error('  elevated privileges; pick a higher one:\n');
    console.error(`      npm start -- --port ${DEFAULT_PORT}\n`);
    process.exit(1);
  }

  console.error(`\n  The server could not start: ${error.message}\n`);
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  Chapter is running.\n');
  console.log(`  This machine:  http://localhost:${PORT}`);
  for (const address of localAddresses()) {
    console.log(`  Other devices: http://${address}:${PORT}`);
  }
  console.log('\n  Library and covers are stored in ./data');

  if (!hadLibrary) {
    // A library that lived in a browser at a different address is invisible
    // here — same machine, different origin, different storage. Saying so
    // beats letting someone conclude their books are gone.
    console.log('\n  No library yet. If you were using Chapter at another address,');
    console.log('  open it there, then Settings > Export JSON, and import the file');
    console.log('  in Settings here. Browser storage does not follow a port change.');
  }
  console.log('');
});

// Ctrl-C should close cleanly rather than leaving the port held.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('\n  Stopping Chapter.\n');
    for (const listener of listeners) {
      try {
        listener.end();
      } catch {
        /* already gone */
      }
    }
    server.close(() => process.exit(0));
    // Don't hang forever on a wedged keep-alive connection.
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
