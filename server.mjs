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
import { readFile, writeFile, mkdir, readdir, stat, rm, rename } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, extname, dirname, normalize, resolve } from 'node:path';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';

import { mergeLibraries, libraryRevision } from './js/data/merge.js';
import {
  coverPath, coverFolder, nameMatchesTitle, safeId, COVER_EXTENSIONS,
} from './js/data/coverNames.js';
import { PROVIDER_HOSTS } from './js/data/providers.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const DATA_DIR = join(ROOT, 'data');
const COVER_DIR = join(DATA_DIR, 'covers');
const LIBRARY_FILE = join(DATA_DIR, 'library.json');
// Which file belongs to which book. Covers are named after titles, and titles
// are neither unique nor permanent, so the mapping has to be written down.
const COVER_INDEX_FILE = join(DATA_DIR, 'cover-index.json');

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

/* --- Where a cover file lives ----------------------------------------------
 *
 * `coverIndex` maps book id to filename. The filename is derived from the
 * book's title, so the folder can be opened, read and edited by a person; the
 * index is what makes that safe when two books share a title or a title gets
 * corrected later.
 * -------------------------------------------------------------------------- */

/** @type {Record<string, string>} bookId -> filename */
let coverIndex = {};

async function loadCoverIndex() {
  try {
    const raw = await readFile(COVER_INDEX_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    coverIndex = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    coverIndex = {};
  }
}

let indexChain = Promise.resolve();
function saveCoverIndex() {
  indexChain = indexChain.then(async () => {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(COVER_INDEX_FILE, JSON.stringify(coverIndex, null, 2), 'utf8');
  }).catch((error) => console.error('  cover index write failed:', error.message));
  return indexChain;
}

const bookFor = (bookId) => library.books?.find((book) => book.id === bookId) ?? null;
const titleFor = (bookId) => bookFor(bookId)?.title ?? '';
const kindFor = (bookId) => bookFor(bookId)?.category ?? 'book';

const typeForExtension = (extension) =>
  Object.keys(EXT_BY_TYPE).find((key) => EXT_BY_TYPE[key] === extension) ?? 'image/jpeg';

/**
 * Write bytes for a book, under a name derived from its title.
 *
 * Any earlier file for the same book is removed first — including one with a
 * different extension, which is how replacing a JPEG with a PNG used to leave
 * both on disk and the stale one winning the lookup.
 */
async function writeCover(bookId, buffer, extension, title, category) {
  const name = coverPath(
    coverIndex,
    bookId,
    title || titleFor(bookId),
    extension,
    category || kindFor(bookId)
  );

  // The folder is part of the name now, so it has to exist before the write.
  await mkdir(join(COVER_DIR, dirname(name)), { recursive: true });

  const previous = coverIndex[bookId];

  await writeFile(join(COVER_DIR, name), buffer);

  if (previous && previous !== name) {
    await rm(join(COVER_DIR, previous), { force: true }).catch(() => null);
  }
  // The pre-index era filed covers under the raw id; clear that too, or it
  // shadows the new file for anyone whose index was rebuilt.
  for (const legacy of COVER_EXTENSIONS.map((ext) => `${safeId(bookId)}${ext}`)) {
    if (legacy !== name) await rm(join(COVER_DIR, legacy), { force: true }).catch(() => null);
  }

  coverIndex[bookId] = name;
  await saveCoverIndex();

  return { bytes: buffer.byteLength, type: typeForExtension(extension), file: name };
}

const signatureOf = (buffer) =>
  IMAGE_MAGIC.find((candidate) => candidate.bytes.every((byte, index) => buffer[index] === byte));

async function storeLocalCover(bookId, path, title, category) {
  if (!ALLOW_LOCAL_COVERS) throw new Error('Local cover reading is disabled on this server.');
  if (!/\.(jpe?g|png|webp|gif)$/i.test(path)) throw new Error('Not an image path.');

  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw new Error('No file at that path on the server.');
  if (info.size < 1024) throw new Error('That file is too small to be a cover.');
  if (info.size > 20 * 1024 * 1024) throw new Error('That file is too large to be a cover.');

  const buffer = await readFile(path);
  const signature = signatureOf(buffer);
  if (!signature) throw new Error('That file is not an image.');

  return writeCover(bookId, buffer, signature.ext, title, category);
}

async function storeCover(bookId, url, title, category) {
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

  return writeCover(bookId, buffer, extension, title, category);
}

/**
 * Store an image the browser already holds — an upload, or a file dropped onto
 * a book in the library.
 *
 * The bytes are checked against image magic numbers rather than trusted from
 * the declared media type, because the media type is just a string in a
 * request body and this writes to disk.
 */
async function storeCoverBytes(bookId, dataUrl, title, category) {
  const match = /^data:(image\/[a-z+]+);base64,([\s\S]+)$/i.exec(String(dataUrl ?? ''));
  if (!match) throw new Error('That upload was not an image.');

  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.byteLength) throw new Error('That upload was empty.');
  if (buffer.byteLength > 10 * 1024 * 1024) throw new Error('That image is too large.');

  const signature = signatureOf(buffer);
  if (!signature) throw new Error('That upload was not an image.');

  return writeCover(bookId, buffer, signature.ext, title, category);
}

async function findCover(bookId) {
  const candidates = [];
  if (coverIndex[bookId]) candidates.push(coverIndex[bookId]);
  // Anything written before the index existed is still on disk under its id.
  for (const extension of COVER_EXTENSIONS) candidates.push(`${safeId(bookId)}${extension}`);

  for (const name of candidates) {
    const path = join(COVER_DIR, name);
    try {
      await stat(path);
      return { path, type: typeForExtension(extname(name)) };
    } catch {
      /* keep looking */
    }
  }
  return null;
}

async function forgetCover(bookId) {
  const name = coverIndex[bookId];
  if (name) {
    await rm(join(COVER_DIR, name), { force: true }).catch(() => null);
    delete coverIndex[bookId];
    await saveCoverIndex();
  }
  for (const extension of COVER_EXTENSIONS) {
    await rm(join(COVER_DIR, `${safeId(bookId)}${extension}`), { force: true }).catch(() => null);
  }
  return { ok: true };
}

/**
 * Bring the folder in line with the library.
 *
 * Runs at boot and after every library push. Two jobs: give a name to files
 * still sitting under a raw record id, and rename anything whose book has
 * since been retitled. Both are done by renaming rather than refetching — the
 * bytes are already correct, and a rename costs nothing.
 */
/** Every cover file, as paths relative to the covers directory. */
async function coverFiles() {
  const entries = await readdir(COVER_DIR, { withFileTypes: true }).catch(() => []);
  const found = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const inner = await readdir(join(COVER_DIR, entry.name)).catch(() => []);
      found.push(...inner.map((name) => `${entry.name}/${name}`));
    } else if (entry.isFile()) {
      // Pre-folder covers, still in the root. Adopted on the next reconcile.
      found.push(entry.name);
    }
  }

  return found;
}

async function reconcileCoverNames() {
  const files = new Set(await coverFiles());
  if (!files.size) return { renamed: 0, adopted: 0 };

  let renamed = 0;
  let adopted = 0;

  for (const book of library.books ?? []) {
    const current = coverIndex[book.id];

    // Adopt: a file named after the id, or one sitting in the root from
    // before covers were filed by kind.
    if (!current || !files.has(current)) {
      const legacy =
        COVER_EXTENSIONS.map((extension) => `${safeId(book.id)}${extension}`).find((name) =>
          files.has(name)
        ) ?? (current && files.has(current) ? current : null);
      if (!legacy) continue;

      const name = coverPath(coverIndex, book.id, book.title, extname(legacy), book.category);
      if (name !== legacy) {
        await mkdir(join(COVER_DIR, dirname(name)), { recursive: true });
        await rename(join(COVER_DIR, legacy), join(COVER_DIR, name)).catch(() => null);
        files.delete(legacy);
        files.add(name);
      }
      coverIndex[book.id] = name;
      adopted += 1;
      continue;
    }

    // Follow a retitling, or a book being reclassified into another folder.
    const wrongFolder = !current.startsWith(`${coverFolder(book.category)}/`);
    if (wrongFolder || !nameMatchesTitle(current, book.title)) {
      const next = coverPath(coverIndex, book.id, book.title, extname(current), book.category);
      if (next !== current) {
        await mkdir(join(COVER_DIR, dirname(next)), { recursive: true });
        await rename(join(COVER_DIR, current), join(COVER_DIR, next)).catch(() => null);
        files.delete(current);
        files.add(next);
        coverIndex[book.id] = next;
        renamed += 1;
      }
    }
  }

  if (renamed || adopted) await saveCoverIndex();
  return { renamed, adopted };
}

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
  response.setHeader('access-control-allow-methods', 'GET,PUT,POST,DELETE,OPTIONS');
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
      // So the client can say where covers actually are, in words, rather than
      // leaving it as folklore.
      coverNaming: 'title',
      covers: Object.keys(coverIndex).length,
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
      // Titles may have changed in that push, and a cover file named after an
      // old title is the same problem as a cover file named after an id.
      reconcileCoverNames().catch(() => null);
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

  /**
   * Delete cover files that belong to no book.
   *
   * The client sends the ids it knows about, because the server's copy of the
   * library may be behind — and deleting files based on a stale library is how
   * a sync lag turns into lost cover art. Nothing is removed unless the client
   * has explicitly listed what to keep.
   */
  if (url.pathname === '/api/covers/prune' && request.method === 'POST') {
    const { bookIds, dryRun } = JSON.parse(await readBody(request));

    if (!Array.isArray(bookIds)) {
      json(response, 400, { error: 'Send the ids of every book you still have.' });
      return;
    }

    const keep = new Set(bookIds.map(String));
    const files = await coverFiles();
    const claimed = new Map(
      Object.entries(coverIndex).filter(([bookId]) => keep.has(bookId)).map(([, file]) => [file, true])
    );

    const orphans = [];
    for (const file of files) {
      if (claimed.has(file)) continue;
      const owner = Object.entries(coverIndex).find(([, name]) => name === file)?.[0] ?? null;
      const info = await stat(join(COVER_DIR, file)).catch(() => null);
      orphans.push({
        file,
        bookId: owner,
        bytes: info?.size ?? 0,
        // When the file was last written, which is the only clue on disk about
        // whether it came from a deletion last week or a restore last year.
        modified: info?.mtime?.toISOString() ?? null,
      });
    }

    if (!dryRun) {
      for (const orphan of orphans) {
        await rm(join(COVER_DIR, orphan.file), { force: true }).catch(() => null);
        if (orphan.bookId) delete coverIndex[orphan.bookId];
      }
      if (orphans.length) await saveCoverIndex();
    }

    json(response, 200, {
      ok: true,
      removed: dryRun ? 0 : orphans.length,
      orphans,
      bytes: orphans.reduce((sum, orphan) => sum + orphan.bytes, 0),
    });
    return;
  }

  // Anything after /api/covers/ is a book id — except the reserved words
  // handled above. Ordering alone kept this correct once and would not have
  // kept it correct twice.
  const coverMatch = url.pathname.match(/^\/api\/covers\/([^/]+)$/);
  if (coverMatch && coverMatch[1] !== 'prune') {
    const bookId = decodeURIComponent(coverMatch[1]);

    if (request.method === 'POST') {
      const { url: source, path: localPath, dataUrl, title, category } =
        JSON.parse(await readBody(request));
      try {
        const result = dataUrl
          ? await storeCoverBytes(bookId, dataUrl, title, category)
          : localPath
            ? await storeLocalCover(bookId, localPath, title, category)
            : await storeCover(bookId, source, title, category);
        json(response, 200, { ok: true, ...result });
      } catch (error) {
        json(response, 200, { ok: false, error: error.message });
      }
      return;
    }

    if (request.method === 'DELETE') {
      await forgetCover(bookId);
      json(response, 200, { ok: true });
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
    const files = await coverFiles();
    let bytes = 0;
    for (const file of files) {
      const info = await stat(join(COVER_DIR, file)).catch(() => null);
      bytes += info?.size ?? 0;
    }
    json(response, 200, {
      count: files.length,
      bytes,
      files,
      // The index the other way round, so a client can show which book a file
      // belongs to without guessing from the name.
      byBook: coverIndex,
      ids: Object.keys(coverIndex),
    });
    return;
  }

  /**
   * Make a catalogue lookup on the browser's behalf.
   *
   * Nothing here needs a key or a secret — the point is CORS. A provider that
   * refuses a cross-origin request from a browser will happily answer a
   * server, and "search returns nothing on my phone" is otherwise impossible
   * to tell apart from "this book isn't in the catalogue".
   *
   * Locked to the provider hosts. An open proxy on a machine on someone's home
   * network is a genuinely bad thing to leave running, and an allowlist of
   * four hostnames costs nothing.
   */
  if (url.pathname === '/api/lookup') {
    const target = url.searchParams.get('url') ?? '';
    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      json(response, 400, { error: 'Not a valid URL.' });
      return;
    }

    if (parsed.protocol !== 'https:' || !PROVIDER_HOSTS.includes(parsed.hostname)) {
      json(response, 403, { error: `${parsed.hostname} is not a catalogue this server will call.` });
      return;
    }

    try {
      const upstream = await fetch(parsed.toString(), {
        redirect: 'follow',
        headers: { accept: 'application/json' },
      });
      const body = await upstream.text();
      response.writeHead(upstream.ok ? 200 : upstream.status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(body);
    } catch (error) {
      json(response, 502, { error: `Could not reach ${parsed.hostname}: ${error.message}` });
    }
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
await loadCoverIndex();
const reconciled = await reconcileCoverNames();
if (reconciled.adopted || reconciled.renamed) {
  console.log(
    `  covers: ${reconciled.adopted} filed under their title, ` +
    `${reconciled.renamed} renamed to follow an edited title`
  );
}

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
  console.log('  Cover files are named after their book: data/covers/the-hobbit.jpg');

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
