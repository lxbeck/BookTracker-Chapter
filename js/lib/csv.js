/**
 * A CSV parser.
 *
 * Splitting on commas breaks on the first book called "Wolf Hall, Part 2" and
 * on every Goodreads review containing a line break. This walks the text
 * character by character, which is the only way to get quoting right.
 *
 * Handles: quoted fields, escaped quotes (""), newlines inside quotes, CRLF,
 * and a UTF-8 byte-order mark, which Excel adds and which otherwise turns the
 * first column name into invisible garbage.
 */

/**
 * @param {string} text
 * @returns {string[][]} rows of raw cells
 */
export function parseCsv(text) {
  const input = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let index = 0;

  while (index < input.length) {
    const char = input[index];

    if (quoted) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }

    if (char === '"') {
      quoted = true;
      index += 1;
      continue;
    }

    if (char === ',') {
      row.push(field);
      field = '';
      index += 1;
      continue;
    }

    if (char === '\r') {
      index += 1;
      continue;
    }

    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      index += 1;
      continue;
    }

    field += char;
    index += 1;
  }

  // Whatever is in hand at the end is a final field, unless the file ended on
  // a clean newline and there is nothing pending.
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/**
 * Parse into objects keyed by the header row.
 * @returns {{headers: string[], rows: Record<string, string>[]}}
 */
export function parseCsvObjects(text) {
  const rows = parseCsv(text).filter((row) => row.some((cell) => cell.trim() !== ''));
  if (!rows.length) return { headers: [], rows: [] };

  const headers = rows[0].map((cell) => cell.trim());

  return {
    headers,
    rows: rows.slice(1).map((cells) =>
      Object.fromEntries(headers.map((header, i) => [header, (cells[i] ?? '').trim()]))
    ),
  };
}
