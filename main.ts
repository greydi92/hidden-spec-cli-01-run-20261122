// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves a successful edit recorded, in order: [old path, new path]. */
  readonly moves: [string, string][] = [];
  recordMove(oldP: string, newP: string): void {
    this.moves.push([oldP, newP]);
  }
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* File lines (SPEC.md section 3) and three-tier matching (section 5) */
/* ------------------------------------------------------------------ */

/** A file's lines, its own line break and whether it ends with one. */
interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => (/^[ \t]*/.exec(s) ?? [''])[0]!;
const onlyWs = (s: string): boolean => /^[ \t]*$/.test(s);

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

/** Positions i where O matches lines[i..] at tier, at or after `from`. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = Math.max(from, 0); i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at or after `from`, with its positions. */
function firstTier(lines: string[], o: string[], strict: boolean, from: number): { tier: number; positions: number[] } | null {
  for (let t = 0; t <= (strict ? 0 : 2); t += 1) {
    const positions = occurrences(lines, o, t, from);
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

/** One line of N: a context line (its index in O) or an added line. */
interface NewLine {
  text: string;
  ctx: number | null;
}

/** The lines N writes when O matched at `pos` at `tier` (section 5). */
function buildNew(fileLines: string[], pos: number, o: string[], n: NewLine[], tier: number): string[] {
  const out: string[] = [];
  const f = o.length > 0 ? leadingWs(fileLines[pos] ?? '') : '';
  const p = o.length > 0 ? leadingWs(o[0]!) : '';
  for (const item of n) {
    if (item.ctx !== null) {
      out.push(fileLines[pos + item.ctx] ?? '');
      continue;
    }
    let t = item.text;
    if (tier === 2 && t !== '' && !onlyWs(t) && t.startsWith(p)) t = f + t.slice(p.length);
    out.push(t);
  }
  return out;
}

/** Split one hunk or chunk body into its old lines O and its new lines N. */
function splitBody(items: { kind: string; text: string }[]): { o: string[]; n: NewLine[] } {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      o.push(it.text);
      n.push({ text: it.text, ctx: o.length - 1 });
    } else if (it.kind === 'old') {
      o.push(it.text);
    } else if (it.kind === 'new') {
      n.push({ text: it.text, ctx: null });
    }
  }
  return { o, n };
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                  */
/* ------------------------------------------------------------------ */

interface HunkItem {
  kind: 'ctx' | 'old' | 'new' | 'backslash';
  text: string;
}

interface Hunk {
  /** The -A of `@@ -A[,B] +C[,D] @@`. */
  a: number;
  items: HunkItem[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
}

/** The path a `--- ` or `+++ ` line names (null: /dev/null). */
function headerPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

/** Whether a `\` line follows the last context or `+` line of a body. */
function bodyNoEol(items: HunkItem[]): boolean {
  for (let k = items.length - 1; k >= 0; k -= 1) {
    const it = items[k]!;
    if (it.kind === 'ctx' || it.kind === 'new') {
      return items[k + 1] !== undefined && items[k + 1]!.kind === 'backslash';
    }
  }
  return false;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const diffGit = (l: string): [string, string] | null => {
    const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(l);
    return m === null ? null : [m[1]!, m[2]!];
  };
  const hunkHead = (l: string): number | null => {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    return m === null ? null : Number(m[1]);
  };
  interface Work {
    oldP: string | null;
    newP: string | null;
    pairNamed: boolean;
    renameFrom: string | null;
    renameTo: string | null;
    diffA: string | null;
    diffB: string | null;
    newFile: boolean;
    deletedFile: boolean;
    hunks: Hunk[];
  }
  const fresh = (diffA: string | null, diffB: string | null): Work => ({
    oldP: null,
    newP: null,
    pairNamed: false,
    renameFrom: null,
    renameTo: null,
    diffA,
    diffB,
    newFile: false,
    deletedFile: false,
    hunks: [],
  });
  const sections: Work[] = [];
  let cur: Work | null = null;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const d = diffGit(l);
      if (d === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh(d[0], d[1]);
      sections.push(cur);
      i += 1;
      continue;
    }
    if (l.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next !== undefined && next.startsWith('+++ ')) {
        if (cur === null || cur.pairNamed || cur.hunks.length > 0) {
          cur = fresh(null, null);
          sections.push(cur);
        }
        cur.oldP = headerPath(l);
        cur.newP = headerPath(next);
        cur.pairNamed = true;
        i += 2;
        continue;
      }
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      const a = hunkHead(l);
      if (a === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const items: HunkItem[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const b = lines[j]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && lines[j + 1] !== undefined && lines[j + 1]!.startsWith('+++ ')) break;
        if (b === '') items.push({ kind: 'ctx', text: '' });
        else if (b.startsWith(' ')) items.push({ kind: 'ctx', text: b.slice(1) });
        else if (b.startsWith('-')) items.push({ kind: 'old', text: b.slice(1) });
        else if (b.startsWith('+')) items.push({ kind: 'new', text: b.slice(1) });
        else if (b.startsWith('\\')) items.push({ kind: 'backslash', text: b.slice(1) });
        else break;
        j += 1;
      }
      while (items.length > 0) {
        const last = items[items.length - 1]!;
        if (last.kind === 'ctx' && last.text === '') items.pop();
        else break;
      }
      cur.hunks.push({ a, items, noEol: bodyNoEol(items) });
      i = j;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (l.startsWith('+++ ')) cur.newP = headerPath(l);
      else if (l.startsWith('rename from ')) cur.renameFrom = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) cur.renameTo = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) cur.newFile = true;
      else if (l.startsWith('deleted file mode')) cur.deletedFile = true;
    }
    i += 1;
  }

  const edits: Edit[] = [];
  for (const sec of sections) {
    const oldP = sec.pairNamed ? sec.oldP : (sec.renameFrom ?? sec.diffA);
    const newP = sec.pairNamed ? sec.newP : (sec.renameTo ?? sec.diffB);
    const isCreate = oldP === null || sec.newFile;
    const isDelete = !isCreate && (newP === null || sec.deletedFile);
    const isMove = !isCreate && !isDelete && oldP !== null && newP !== null && oldP !== newP;
    edits.push((tree) => {
      if (isCreate) {
        if (newP === null) return;
        if (!safe(newP)) throw new Fail('unsafe', newP);
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const plus: string[] = [];
        for (const h of sec.hunks) for (const it of h.items) if (it.kind === 'new') plus.push(it.text);
        let noEol = false;
        outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi -= 1) {
          const items = sec.hunks[hi]!.items;
          for (let k = items.length - 1; k >= 0; k -= 1) {
            if (items[k]!.kind === 'new') {
              noEol = items[k + 1] !== undefined && items[k + 1]!.kind === 'backslash';
              break outer;
            }
          }
        }
        tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
        return;
      }
      if (oldP === null) return;
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (isMove && newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
      const content = tree.get(oldP);
      if (content === null) throw new Fail('missing', oldP);
      if (isDelete) {
        tree.now.set(oldP, null);
        return;
      }
      if (isMove && tree.get(newP!) !== null) throw new Fail('exists', newP!);
      const f = splitFile(content);
      let d = 0;
      for (const h of sec.hunks) {
        const { o, n } = splitBody(h.items);
        if (o.length === 0) {
          const idx = Math.min(Math.max(h.a + d, 0), f.lines.length);
          const ins = n.map((x) => x.text);
          const atEnd = idx === f.lines.length;
          f.lines.splice(idx, 0, ...ins);
          if (atEnd) f.final = !h.noEol;
          d += n.length;
          continue;
        }
        const found = firstTier(f.lines, o, strict, 0);
        if (found === null) throw new Fail('no-match', oldP);
        const target = h.a - 1 + d;
        let best = found.positions[0]!;
        for (const p of found.positions) {
          if (Math.abs(p - target) < Math.abs(best - target)) best = p;
        }
        const runsToEnd = best + o.length === f.lines.length;
        const repl = buildNew(f.lines, best, o, n, found.tier);
        f.lines.splice(best, o.length, ...repl);
        if (runsToEnd) f.final = !h.noEol;
        d += n.length - o.length;
      }
      const out = joinFile(f);
      if (isMove) {
        tree.now.set(oldP, null);
        tree.now.set(newP!, out);
        tree.recordMove(oldP, newP!);
      } else {
        tree.now.set(oldP, out);
      }
    });
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                          */
/* ------------------------------------------------------------------ */

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let k = i - 1; k > prevEnd; k -= 1) {
      const cand = lines[k]!;
      if (blank(cand) || cand.trim().startsWith('```')) continue;
      path = cand.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let k = i + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
    let end = -1;
    for (let k = eq + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        end = k;
        break;
      }
    }
    if (end === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, end);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
        return;
      }
      const content = tree.get(p);
      if (content === null) throw new Fail('missing', p);
      const f = splitFile(content);
      const found = firstTier(f.lines, oldLines, strict, 0);
      if (found === null) throw new Fail('no-match', p);
      if (found.positions.length > 1) throw new Fail('ambiguous', p);
      const pos = found.positions[0]!;
      const n: NewLine[] = newLines.map((t) => ({ text: t, ctx: null }));
      f.lines.splice(pos, oldLines.length, ...buildNew(f.lines, pos, oldLines, n, found.tier));
      tree.now.set(p, joinFile(f));
    });
    prevPath = p;
    prevEnd = end;
    i = end + 1;
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                    */
/* ------------------------------------------------------------------ */

interface VChunk {
  anchor: string | null;
  items: { kind: 'ctx' | 'old' | 'new'; text: string }[];
  eof: boolean;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  interface Raw {
    kind: 'add' | 'delete' | 'update';
    path: string;
    headLine: number;
    body: { text: string; no: number }[];
  }
  const raws: Raw[] = [];
  let cur: Raw | null = null;
  const pushCur = (): void => {
    if (cur === null) return;
    while (cur.body.length > 0 && blank(cur.body[cur.body.length - 1]!.text)) cur.body.pop();
    raws.push(cur);
    cur = null;
  };
  for (let k = first + 1; k < last; k += 1) {
    const l = lines[k]!;
    const no = k + 1;
    if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) {
      pushCur();
      const kind = l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'delete' : 'update';
      const prefix = kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
      cur = { kind, path: l.slice(prefix.length).trim(), headLine: no, body: [] };
      continue;
    }
    if (cur === null) {
      if (blank(l)) continue;
      throw new Exit2(`error: parse ${no}`);
    }
    cur.body.push({ text: l, no });
  }
  pushCur();

  const edits: Edit[] = [];
  for (const raw of raws) {
    if (raw.kind === 'add') {
      const fileLines: string[] = [];
      for (const b of raw.body) {
        if (b.text === '') fileLines.push('');
        else if (b.text.startsWith('+')) fileLines.push(b.text.slice(1));
        else throw new Exit2(`error: parse ${b.no}`);
      }
      const p = raw.path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fileLines.length === 0 ? '' : `${fileLines.join('\n')}\n`);
      });
      continue;
    }
    if (raw.kind === 'delete') {
      if (raw.body.length > 0) throw new Exit2(`error: parse ${raw.body[0]!.no}`);
      const p = raw.path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      continue;
    }
    let moveTo: string | null = null;
    let idx = 0;
    if (raw.body.length > 0 && raw.body[0]!.text.startsWith('*** Move to: ')) {
      moveTo = raw.body[0]!.text.slice('*** Move to: '.length).trim();
      idx = 1;
    }
    const chunks: VChunk[] = [];
    let chunk: VChunk | null = null;
    for (; idx < raw.body.length; idx += 1) {
      const b = raw.body[idx]!;
      const l = b.text;
      if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
        if (chunk === null) chunk = { anchor: null, items: [], eof: false };
        if (l === '') chunk.items.push({ kind: 'ctx', text: '' });
        else if (l.startsWith(' ')) chunk.items.push({ kind: 'ctx', text: l.slice(1) });
        else if (l.startsWith('-')) chunk.items.push({ kind: 'old', text: l.slice(1) });
        else chunk.items.push({ kind: 'new', text: l.slice(1) });
        continue;
      }
      if (l.startsWith('@@')) {
        if (chunk !== null) {
          chunks.push(chunk);
          chunk = null;
        }
        const anchor = l.slice(2).trim();
        chunk = { anchor: anchor === '' ? null : anchor, items: [], eof: false };
        continue;
      }
      if (l.trim() === '*** End of File') {
        if (chunk === null) throw new Exit2(`error: parse ${b.no}`);
        chunk.eof = true;
        chunks.push(chunk);
        chunk = null;
        continue;
      }
      throw new Exit2(`error: parse ${b.no}`);
    }
    if (chunk !== null) chunks.push(chunk);
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${raw.headLine}`);
    const p = raw.path;
    const mt = moveTo;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (mt !== null && !safe(mt)) throw new Fail('unsafe', mt);
      const content = tree.get(p);
      if (content === null) throw new Fail('missing', p);
      if (mt !== null && tree.get(mt) !== null) throw new Fail('exists', mt);
      const f = splitFile(content);
      let cursor = 0;
      for (const ch of chunks) {
        if (ch.anchor !== null) {
          const found = firstTier(f.lines, [ch.anchor], strict, cursor);
          if (found === null) throw new Fail('no-match', p);
          cursor = found.positions[0]! + 1;
        }
        const { o, n } = splitBody(ch.items);
        if (o.length === 0) {
          const at = ch.eof ? f.lines.length : cursor;
          const ins = n.map((x) => x.text);
          f.lines.splice(at, 0, ...ins);
          cursor = at + ins.length;
          continue;
        }
        if (ch.eof) {
          const pos = f.lines.length - o.length;
          if (pos < cursor) throw new Fail('no-match', p);
          let tier = -1;
          for (let t = 0; t <= (strict ? 0 : 2); t += 1) {
            let ok = true;
            for (let j = 0; j < o.length; j += 1) {
              if (!lineEq(f.lines[pos + j]!, o[j]!, t)) {
                ok = false;
                break;
              }
            }
            if (ok) {
              tier = t;
              break;
            }
          }
          if (tier < 0) throw new Fail('no-match', p);
          const repl = buildNew(f.lines, pos, o, n, tier);
          f.lines.splice(pos, o.length, ...repl);
          cursor = pos + repl.length;
          continue;
        }
        const found = firstTier(f.lines, o, strict, cursor);
        if (found === null) throw new Fail('no-match', p);
        const pos = found.positions[0]!;
        const repl = buildNew(f.lines, pos, o, n, found.tier);
        f.lines.splice(pos, o.length, ...repl);
        cursor = pos + repl.length;
      }
      const out = joinFile(f);
      if (mt !== null) {
        tree.now.set(p, null);
        tree.now.set(mt, out);
        tree.recordMove(p, mt);
      } else {
        tree.now.set(p, out);
      }
    });
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? searchReplaceEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const moved = new Set<string>();
  const rows: { key: string; row: string }[] = [];
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, row: `R ${oldP} -> ${newP}` });
      moved.add(oldP);
      moved.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (moved.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, row: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outRows = rows.map((r) => r.row);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
