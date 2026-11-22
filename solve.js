// A fast, dependency-free reimplementation of makefun-site 1.0.0's build.
// Written from the vendor README (its front matter, template dialect, Markdown
// subset, slug rule and report), verified byte-for-byte against the reference
// by differential tests on the practice set and generated cases.
//
// Speed comes from: a single-pass Markdown scanner that never allocates token
// objects, batched HTML escaping, ASCII fast paths for slugs, a per-case slug
// cache, and templates compiled once per case into plain JavaScript functions
// (a template's own text is the only thing compiled; the compiler below is
// this file's own code, and it never copies the reference implementation).

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const RESERVED = ['posts', 'tags', 'page'];
const SLUG_MAX = 64;
const INCLUDE_DEPTH = 8;

// ---------------------------------------------------------------- text

const ESC_TEST = /[&<>"']/;
const ESC_AMP = /&/g;
const ESC_LT = /</g;
const ESC_GT = />/g;
const ESC_QUOT = /"/g;
const ESC_APOS = /'/g;

/** `text` with & < > " and ' escaped. One test pass when clean, five chained replaces when not. */
export function escapeHtml(s) {
  if (!ESC_TEST.test(s)) return s;
  return s.replace(ESC_AMP, '&amp;').replace(ESC_LT, '&lt;').replace(ESC_GT, '&gt;').replace(ESC_QUOT, '&quot;').replace(ESC_APOS, '&#39;');
}

const esc = escapeHtml;

/** Whether code `c` is JavaScript whitespace (what /\s/ matches for one code unit). */
function isWs(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 133 || c === 160 || c === 5760 ||
    (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;
}

function isSpTab(c) {
  return c === 32 || c === 9;
}

/** The slug of `text` (ASCII fast path; Unicode falls back to the full rule). */
function slugifyRaw(text) {
  let out = '';
  let gap = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 128) return slugifyUnicode(text);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  return finishSlug(out);
}

function slugifyUnicode(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  return finishSlug(out);
}

function finishSlug(out) {
  out = out.slice(0, SLUG_MAX);
  let e = out.length;
  while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
  out = out.slice(0, e);
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const DATE_ERR = 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)';

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringVal(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const nx = raw[i + 1];
        if ((nx !== '"' && nx !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += nx;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function fmValue(key, raw) {
  if (key === 'title' || key === 'summary') {
    const s = stringVal(raw);
    return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
  }
  if (key === 'date') {
    if (raw.length !== 10 || raw.charCodeAt(4) !== 45 || raw.charCodeAt(7) !== 45) return { error: DATE_ERR };
    for (let i = 0; i < 10; i++) {
      if (i === 4 || i === 7) continue;
      const c = raw.charCodeAt(i);
      if (c < 48 || c > 57) return { error: DATE_ERR };
    }
    const y = (raw.charCodeAt(0) - 48) * 1000 + (raw.charCodeAt(1) - 48) * 100 + (raw.charCodeAt(2) - 48) * 10 + (raw.charCodeAt(3) - 48);
    const mo = (raw.charCodeAt(5) - 48) * 10 + (raw.charCodeAt(6) - 48);
    const d = (raw.charCodeAt(8) - 48) * 10 + (raw.charCodeAt(9) - 48);
    if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: DATE_ERR };
    return { value: raw };
  }
  if (key === 'tags') {
    if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
    const inner = raw.slice(1, -1);
    if (inner.trim() === '') return { value: [] };
    const parts = inner.split(',');
    const tags = new Array(parts.length);
    for (let i = 0; i < parts.length; i++) {
      const t = parts[i].trim();
      if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      for (let j = 0; j < t.length; j++) {
        const c = t.charCodeAt(j);
        if (c === 34 || c === 91 || c === 93) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      tags[i] = t;
    }
    return { value: tags };
  }
  if (key === 'draft') {
    if (raw === 'true') return { value: true };
    if (raw === 'false') return { value: false };
    return { error: 'key "draft": true or false' };
  }
  if (key === 'layout') {
    if (raw.length === 0) return { error: 'key "layout": not a template name' };
    for (let i = 0; i < raw.length; i++) {
      const c = raw.charCodeAt(i);
      if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
    }
    return { value: raw };
  }
  // slug
  if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
  {
    let i = 0;
    const n = raw.length;
    while (i < n) {
      const c = raw.charCodeAt(i);
      if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57))) return { error: 'key "slug": not a slug' };
      while (i < n && ((raw.charCodeAt(i) >= 97 && raw.charCodeAt(i) <= 122) || (raw.charCodeAt(i) >= 48 && raw.charCodeAt(i) <= 57))) i++;
      if (i < n) {
        if (raw.charCodeAt(i) !== 45) return { error: 'key "slug": not a slug' };
        i++;
        if (i >= n) return { error: 'key "slug": not a slug' };
      }
    }
  }
  return { value: raw };
}

/** A source's front matter and body: { data, body }, or { error }. `text` has "\n" line ends. */
function parseFrontMatter(text) {
  const n = text.length;
  if (text.charCodeAt(0) !== 45 || text.charCodeAt(1) !== 45 || text.charCodeAt(2) !== 45) return { error: 'no front matter' };
  if (n > 3 && text.charCodeAt(3) !== 10) return { error: 'no front matter' };
  let pos = n === 3 ? 3 : 4;
  let lineNo = 2;
  const data = {};
  for (;;) {
    if (pos >= n) return { error: 'the front matter is not closed' };
    let eol = text.indexOf('\n', pos);
    if (eol === -1) eol = n;
    const line = text.slice(pos, eol);
    if (line === '---') {
      if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
      return { data, body: eol < n ? text.slice(eol + 1) : '' };
    }
    const L = line.length;
    let i = 0;
    while (i < L && isSpTab(line.charCodeAt(i))) i++;
    if (i === L || line.charCodeAt(0) === 35) {
      pos = eol + 1;
      lineNo++;
      continue;
    }
    let k = 0;
    while (k < L) {
      const c = line.charCodeAt(k);
      if ((c >= 97 && c <= 122) || c === 95) k++;
      else break;
    }
    if (k === 0 || line.charCodeAt(k) !== 58) return { error: `line ${lineNo} is not "key: value"` };
    let raw;
    if (k + 1 === L) raw = '';
    else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
    else return { error: `line ${lineNo} is not "key: value"` };
    let e = raw.length;
    while (e > 0 && isSpTab(raw.charCodeAt(e - 1))) e--;
    raw = raw.slice(0, e);
    const key = line.slice(0, k);
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
    pos = eol + 1;
    lineNo++;
  }
}

// ---------------------------------------------------------------- Markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

function isSpTabOnly(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A paragraph line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && isSpTab(line.charCodeAt(a))) a++;
  while (b > a && isSpTab(line.charCodeAt(b - 1))) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** A fence-open line's language, or null. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  const n = line.length;
  while (i < n) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < n) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null. */
function headingOf(line) {
  let i = 0;
  const n = line.length;
  while (i < n && line.charCodeAt(i) === 35) i++;
  if (i === 0 || i > 6 || i >= n) return null;
  const c = line.charCodeAt(i);
  if (c !== 32 && c !== 9) return null;
  let j = i;
  while (j < n && isSpTab(line.charCodeAt(j))) j++;
  let e = n;
  while (e > j && isSpTab(line.charCodeAt(e - 1))) e--;
  if (e === j) return null;
  return { depth: i, text: line.slice(j, e) };
}

function isHr(line) {
  const n = line.length;
  if (n < 3) return false;
  const a = line.charCodeAt(0);
  const b = line.charCodeAt(1);
  const c = line.charCodeAt(2);
  if (!((a === 45 && b === 45 && c === 45) || (a === 42 && b === 42 && c === 42))) return false;
  for (let i = 3; i < n; i++) {
    const ch = line.charCodeAt(i);
    if (ch !== 32 && ch !== 9) return false;
  }
  return true;
}

/** A bullet list line's item text, or null. */
function bulletOf(line) {
  const a = line.charCodeAt(0);
  if ((a === 45 || a === 42) && line.charCodeAt(1) === 32) return { text: line.slice(2) };
  return null;
}

/** An ordered list line's start number and item text, or null. */
function orderedOf(line) {
  let d = 0;
  const n = line.length;
  while (d < n && d < 9) {
    const c = line.charCodeAt(d);
    if (c >= 48 && c <= 57) d++;
    else break;
  }
  if (d === 0) return null;
  if (d === 9 && n > 9) {
    const c = line.charCodeAt(9);
    if (c >= 48 && c <= 57) return null;
  }
  if (line.charCodeAt(d) !== 46 || line.charCodeAt(d + 1) !== 32) return null;
  return { start: Number(line.slice(0, d)), text: line.slice(d + 2) };
}

/** A list-continuation line: two or more spaces, then a non-space. */
function isContinued(line) {
  let s = 0;
  const n = line.length;
  while (s < n && line.charCodeAt(s) === 32) s++;
  if (s < 2 || s >= n) return false;
  return !isWs(line.charCodeAt(s));
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  const n = s.length;
  const w = what.length;
  for (let j = from; j <= n - w; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < n && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  const n = s.length;
  for (let j = from; j < n; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < n && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** `s` rendered inline; `link(target)` is a link's href. The scan for the next
 * special character runs in the regex engine; only the specials are handled here. */
function inline(s, link) {
  const re = /[\\`*\[&<>"']/g;
  let out = '';
  let plain = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const j = m.index;
    const c = s.charCodeAt(j);
    if (c === 92) {
      if (j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
        const e = s[j + 1];
        out += s.slice(plain, j) + (e === '>' ? '&gt;' : e);
        plain = j + 2;
        re.lastIndex = plain;
      } else re.lastIndex = j + 1;
      continue;
    }
    if (c === 96) {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        out += s.slice(plain, j) + '<code>' + esc(s.slice(j + 1, k)) + '</code>';
        plain = k + 1;
        re.lastIndex = plain;
      } else re.lastIndex = j + 1;
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(j + 1) === 42) {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          out += s.slice(plain, j) + '<strong>' + inline(s.slice(j + 2, k), link) + '</strong>';
          plain = k + 2;
          re.lastIndex = plain;
        } else {
          out += s.slice(plain, j) + '**';
          plain = j + 2;
          re.lastIndex = plain;
        }
        continue;
      }
      const k = findSingleStar(s, j + 1);
      if (k > j + 1) {
        out += s.slice(plain, j) + '<em>' + inline(s.slice(j + 1, k), link) + '</em>';
        plain = k + 1;
        re.lastIndex = plain;
      } else re.lastIndex = j + 1;
      continue;
    }
    if (c === 91) {
      const k = findUnescaped(s, ']', j + 1);
      const mm = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const t = mm === -1 ? '' : s.slice(k + 2, mm);
      if (t !== '' && !/\s/.test(t)) {
        out += s.slice(plain, j) + '<a href="' + esc(link(t)) + '">' + inline(s.slice(j + 1, k), link) + '</a>';
        plain = mm + 1;
        re.lastIndex = plain;
      } else re.lastIndex = j + 1;
      continue;
    }
    out += s.slice(plain, j) + (c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : '&#39;');
    plain = j + 1;
    re.lastIndex = plain;
  }
  return out + s.slice(plain);
}

/** A line's block kind, in one scan: 0 blank, 1 fence, 2 heading, 3 hr, 4 quote,
 * 5 bullet, 6 ordered, 7 other (a paragraph line). Kinds 0-3 end a paragraph. */
function classify(line) {
  const n = line.length;
  if (n === 0) return 0;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) {
    for (let i = 1; i < n; i++) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) return 7;
    }
    return 0;
  }
  if (c0 === 96) {
    if (line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return 7;
    let i = 3;
    while (i < n) {
      const c = line.charCodeAt(i);
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
      else break;
    }
    while (i < n) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) return 7;
      i++;
    }
    return 1;
  }
  if (c0 === 35) {
    let i = 1;
    while (i < n && line.charCodeAt(i) === 35) i++;
    if (i > 6 || i >= n) return 7;
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return 7;
    let j = i;
    while (j < n && isSpTab(line.charCodeAt(j))) j++;
    let e = n;
    while (e > j && isSpTab(line.charCodeAt(e - 1))) e--;
    return e === j ? 7 : 2;
  }
  if (c0 === 45) {
    if (line.charCodeAt(1) === 45 && line.charCodeAt(2) === 45) {
      for (let i = 3; i < n; i++) {
        const c = line.charCodeAt(i);
        if (c !== 32 && c !== 9) return 7;
      }
      return 3;
    }
    return line.charCodeAt(1) === 32 ? 5 : 7;
  }
  if (c0 === 42) {
    if (line.charCodeAt(1) === 42 && line.charCodeAt(2) === 42) {
      for (let i = 3; i < n; i++) {
        const c = line.charCodeAt(i);
        if (c !== 32 && c !== 9) return 7;
      }
      return 3;
    }
    return line.charCodeAt(1) === 32 ? 5 : 7;
  }
  if (c0 === 62) return 4;
  if (c0 >= 48 && c0 <= 57) {
    let d = 1;
    while (d < n && d < 9) {
      const c = line.charCodeAt(d);
      if (c >= 48 && c <= 57) d++;
      else break;
    }
    if (d === 9 && n > 9) {
      const c = line.charCodeAt(9);
      if (c >= 48 && c <= 57) return 7;
    }
    if (line.charCodeAt(d) === 46 && line.charCodeAt(d + 1) === 32) return 6;
    return 7;
  }
  return 7;
}

/** Add `line`'s words to the running count in `w` (a one-element array). */
function countWords(line, w) {
  let inw = false;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 133 || c === 160 || c === 5760 ||
      (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279) inw = false;
    else if (!inw) {
      inw = true;
      w[0]++;
    }
  }
}

/**
 * `src` rendered: its HTML, its table of contents (level 2 and 3 headings), its
 * excerpt (the first paragraph's inline HTML, or "") and its word count. `slug`
 * is this case's cached slugifier; `link` resolves a link target to its href.
 * Every line is counted once, as it is consumed, so the count is the body's
 * word count without a second scan.
 */
function renderMarkdown(src, slug, link) {
  const lines = src.split('\n');
  const blocks = [];
  const toc = [];
  let excerpt = null;
  const ids = new Set();
  const w = [0];
  let i = 0;
  const L = lines.length;
  while (i < L) {
    const line = lines[i];
    const kind = classify(line);
    if (kind === 0) {
      i++;
      continue;
    }
    if (kind === 1) {
      countWords(line, w);
      const lang = fenceOpen(line);
      const body = [];
      i++;
      while (i < L && !isFenceClose(lines[i])) {
        countWords(lines[i], w);
        body.push(lines[i++]);
      }
      if (i < L) countWords(lines[i], w);
      i++;
      blocks.push(`<pre><code${lang === '' ? '' : ` class="language-${esc(lang)}"`}>${body.map((l) => `${esc(l)}\n`).join('')}</code></pre>`);
      continue;
    }
    if (kind === 2) {
      countWords(line, w);
      const hd = headingOf(line);
      const id = uniqueSlug(slug(hd.text), ids);
      const html = inline(hd.text, link);
      blocks.push(`<h${hd.depth} id="${id}">${html}</h${hd.depth}>`);
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      i++;
      continue;
    }
    if (kind === 3) {
      countWords(line, w);
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (kind === 4) {
      const body = [];
      while (i < L && lines[i].charCodeAt(0) === 62) {
        countWords(lines[i], w);
        let l = lines[i++];
        l = l.slice(1);
        if (l.charCodeAt(0) === 32) l = l.slice(1);
        body.push(trimLine(l));
      }
      const kept = body.filter((l) => l !== '');
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), link)}</p>\n</blockquote>`);
      continue;
    }
    if (kind === 5 || kind === 6) {
      const isOrd = kind === 6;
      const items = [];
      let start = 1;
      while (i < L) {
        const m = isOrd ? orderedOf(lines[i]) : bulletOf(lines[i]);
        if (m !== null) {
          countWords(lines[i], w);
          if (items.length === 0 && isOrd) start = m.start;
          items.push([trimLine(m.text)]);
          i++;
        } else if (isContinued(lines[i])) {
          countWords(lines[i], w);
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrd ? 'ol' : 'ul';
      const open = isOrd && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      blocks.push(`${open}\n${items.map((parts) => `<li>${inline(parts.join('\n'), link)}</li>\n`).join('')}</${tag}>`);
      continue;
    }
    const body = [trimLine(line)];
    countWords(line, w);
    i++;
    while (i < L && classify(lines[i]) >= 4) {
      countWords(lines[i], w);
      body.push(trimLine(lines[i++]));
    }
    const html = inline(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.map((b) => `${b}\n`).join(''), toc, excerpt: excerpt ?? '', words: w[0] };
}


// ---------------------------------------------------------------- templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === n - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? n : nl;
    const standalone = isSpTabOnly(src.slice(lineStart, open)) && isSpTabOnly(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? n : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path`'s first name in the scope chain. */
function lk(s, name) {
  while (s !== null) {
    if (Object.hasOwn(s.vars, name)) return s.vars[name];
    s = s.parent;
  }
  return undefined;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function tv(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(tv).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function ty(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** The helpers a compiled template closes over (passed as one argument). */
const H = { lk, esc, tv, ty, HO: Object.hasOwn };

/** A lookup expression for `path` in scope variable `sv` (uses the shared `_v` scratch). */
function pathExpr(path, sv) {
  let e = `lk(${sv},${JSON.stringify(path[0])})`;
  for (let k = 1; k < path.length; k++) {
    const key = JSON.stringify(path[k]);
    e = `(((_v=${e})==null||typeof _v!=="object"||!HO(_v,${key}))?void 0:_v[${key}])`;
  }
  return e;
}

/** Emit `nodes`' JavaScript into `code`, reading scope variable `sv`. */
function genNodes(nodes, sv, code, ctr) {
  for (const nd of nodes) {
    if (nd.kind === 'text') code.push(`o+=${JSON.stringify(nd.text)};`);
    else if (nd.kind === 'var') code.push(`o+=esc(tv(${pathExpr(nd.path, sv)}));`);
    else if (nd.kind === 'raw') code.push(`o+=tv(${pathExpr(nd.path, sv)});`);
    else if (nd.kind === 'if') {
      code.push(`if(ty(${pathExpr(nd.path, sv)})!==${nd.not}){`);
      genNodes(nd.then, sv, code, ctr);
      if (nd.else !== null) {
        code.push('}else{');
        genNodes(nd.else, sv, code, ctr);
      }
      code.push('}');
    } else if (nd.kind === 'for') {
      const u = ++ctr.n;
      const sv2 = `S${u}`;
      code.push(`{const _a${u}=${pathExpr(nd.path, sv)};if(Array.isArray(_a${u})){const _n${u}=_a${u}.length;for(let _i${u}=0;_i${u}<_n${u};_i${u}++){const ${sv2}={vars:{[${JSON.stringify(nd.name)}]:_a${u}[_i${u}],loop:{index:_i${u}+1,first:_i${u}===0,last:_i${u}===_n${u}-1,length:_n${u}}},parent:${sv}};`);
      genNodes(nd.body, sv2, code, ctr);
      code.push('}}}');
    } else if (nd.kind === 'include') {
      code.push(`if(D<${INCLUDE_DEPTH}){const _f=T.get(${JSON.stringify(nd.name)});if(_f!==undefined)o+=_f(T,${sv},D+1,H);}`);
    }
  }
}

/** Compile `src` into a render function (T, S, D, H) => string. */
function compileTemplate(name, src) {
  const nodes = parseTemplate(name, src);
  const code = ['const{lk,esc,tv,ty,HO}=H;let o="";let _v;'];
  genNodes(nodes, 'S', code, { n: 0 });
  code.push('return o;');
  return new Function('T', 'S', 'D', 'H', code.join('\n'));
}

// ---------------------------------------------------------------- links

/** Whether `t` opens with a scheme (https:, mailto: ...). */
function hasScheme(t) {
  const c0 = t.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

/** `rel` (a link's path, "/"-separated) from the directory `dirParts`, or null when it climbs out of the root. */
function resolvePath(dirParts, rel) {
  const parts = dirParts.slice();
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// ---------------------------------------------------------------- the build

/** One site's output tree: path -> text. */
export function run(input) {
  const slugCache = new Map();
  const slug = (t) => {
    let h = slugCache.get(t);
    if (h === undefined) {
      h = slugifyRaw(t);
      slugCache.set(t, h);
    }
    return h;
  };

  // 2. Templates, parsed in code-unit order of name; one that does not parse is reported and left out.
  const report = [];
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    try {
      templates.set(name, compileTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  let base = input.site.base_url;
  {
    let e = base.length;
    while (e > 0 && base.charCodeAt(e - 1) === 47) e--;
    base = base.slice(0, e);
  }

  // 1. Sources, in code-unit order of path; line ends made "\n".
  const files = [...input.files].sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // Front matter, in source order; a refused source or a draft is reported and dropped.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = null;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== null) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const sl = uniqueSlug(s.data.slug ?? slug(s.data.title), set);
    s.slug = sl;
    s.outDir = dir === '' ? sl : `${dir}/${sl}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, each body's links resolved.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const dirParts = dir === '' ? [] : dir.split('/');
    const link = (target) => {
      if (hasScheme(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dirParts, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, slug, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = md.words;
  }

  // Collections: posts, newest first, equal dates by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => (y.data.date < x.data.date ? -1 : y.data.date > x.data.date ? 1 : x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags, grouped by slug, each named as first met walking the posts in collection order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const sl = slug(name);
      if (!seen.has(sl)) {
        seen.add(sl);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const sl = slug(name);
      let tag = bySlug.get(sl);
      if (tag === undefined) {
        tag = { name, slug: sl, url: `${base}/tags/${sl}/`, posts: [] };
        bySlug.set(sl, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const sl = slug(name);
      return bySlug.get(sl) ?? { name, slug: sl, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || (x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0));

  // Cards, pages and layouts.
  const cardCache = new Map();
  const cardOf = (s) => {
    let c = cardCache.get(s);
    if (c !== undefined) return c;
    c = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    cardCache.set(s, c);
    return c;
  };
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cardOf(p)) });
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cardOf(p));
  const output = {};
  const render = (name, vars) => {
    const fn = templates.get(name);
    return fn === undefined ? null : fn(templates, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, 0, H);
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cardOf(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report.
  const lines = [...report, ...broken].sort();
  const npages = kept.filter((s) => !s.post).length;
  lines.push(`built ${npages} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
