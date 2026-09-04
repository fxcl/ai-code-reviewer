import type { ChangedFile, DiffLine, FileStatus, Hunk } from './types';

const DIFF_GIT = /^diff --git a\/(.+) b\/(.+)$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

interface SegmentMeta {
  path: string | null;
  oldPath: string | null;
  status: FileStatus;
  binary: boolean;
}

/**
 * Parse a git unified diff into structured files. Unparseable segments are
 * skipped rather than throwing; empty input yields an empty array.
 */
export function parseUnifiedDiff(diff: string): ChangedFile[] {
  if (diff.trim() === '') return [];
  const lines = diff.split('\n');
  const files: ChangedFile[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break;
    if (line.startsWith('diff --git ')) {
      const [file, next] = parseFileSegment(lines, i);
      if (file !== null) files.push(file);
      i = next > i ? next : i + 1;
    } else {
      i += 1;
    }
  }
  return files;
}

function parseFileSegment(
  lines: readonly string[],
  start: number,
): readonly [ChangedFile | null, number] {
  const initial = parseDiffGitPaths(lines[start] ?? '');
  const meta: SegmentMeta = {
    path: initial.path,
    oldPath: initial.oldPath,
    status: 'modified',
    binary: false,
  };
  const hunks: Hunk[] = [];
  let i = start + 1;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined || line.startsWith('diff --git ')) break;
    if (line.startsWith('@@')) {
      const [hunk, next] = parseOneHunk(lines, i);
      if (hunk !== null) hunks.push(hunk);
      i = next > i ? next : i + 1;
      continue;
    }
    applyMetaLine(meta, line);
    i += 1;
  }
  return [finalizeFile(meta, hunks), i];
}

function applyMetaLine(meta: SegmentMeta, line: string): void {
  if (line.startsWith('new file mode')) meta.status = 'added';
  else if (line.startsWith('deleted file mode')) meta.status = 'deleted';
  else if (line.startsWith('rename from ')) {
    meta.oldPath = line.slice('rename from '.length);
    meta.status = 'renamed';
  } else if (line.startsWith('rename to ')) {
    meta.path = line.slice('rename to '.length);
    meta.status = 'renamed';
  } else if (line.startsWith('Binary files')) meta.binary = true;
  else if (line.startsWith('--- ')) {
    const p = stripPathMarker(line.slice(4));
    if (p !== null) meta.oldPath = p;
  } else if (line.startsWith('+++ ')) {
    const p = stripPathMarker(line.slice(4));
    if (p !== null) meta.path = p;
  }
}

function finalizeFile(meta: SegmentMeta, hunks: readonly Hunk[]): ChangedFile | null {
  let path = meta.path;
  let oldPath = meta.oldPath;
  if (path === null && meta.status === 'deleted') path = oldPath;
  if (meta.status !== 'renamed') oldPath = null;
  if (path === null) return null;
  return { path, oldPath, status: meta.status, binary: meta.binary, hunks };
}

function parseDiffGitPaths(line: string): { path: string | null; oldPath: string | null } {
  const match = DIFF_GIT.exec(line);
  const oldP = match?.[1];
  const newP = match?.[2];
  if (oldP === undefined || newP === undefined) return { path: null, oldPath: null };
  return { oldPath: oldP, path: newP };
}

function stripPathMarker(raw: string): string | null {
  const tab = raw.indexOf('\t');
  const trimmed = tab === -1 ? raw : raw.slice(0, tab);
  if (trimmed === '/dev/null') return null;
  if (trimmed.startsWith('a/') || trimmed.startsWith('b/')) return trimmed.slice(2);
  return trimmed;
}

function parseOneHunk(
  lines: readonly string[],
  start: number,
): readonly [Hunk | null, number] {
  const header = lines[start] ?? '';
  const match = HUNK_HEADER.exec(header);
  if (match === null) return [null, start + 1];
  const oldStart = Number(match[1]);
  const oldLines = match[2] === undefined ? 1 : Number(match[2]);
  const newStart = Number(match[3]);
  const newLines = match[4] === undefined ? 1 : Number(match[4]);
  const cursor = { oldLine: oldStart, newLine: newStart };
  const body: DiffLine[] = [];
  let i = start + 1;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break;
    const classified = classifyBodyLine(line, cursor);
    if (classified === 'stop') break;
    if (classified !== 'skip') body.push(classified);
    i += 1;
  }
  return [{ header, oldStart, oldLines, newStart, newLines, lines: body }, i];
}

interface LineCursor {
  oldLine: number;
  newLine: number;
}

function classifyBodyLine(line: string, cursor: LineCursor): DiffLine | 'stop' | 'skip' {
  const marker = line[0];
  const content = line.slice(1);
  if (marker === ' ') {
    const diffLine: DiffLine = { kind: 'context', content, oldLine: cursor.oldLine, newLine: cursor.newLine };
    cursor.oldLine += 1;
    cursor.newLine += 1;
    return diffLine;
  }
  if (marker === '+') {
    const diffLine: DiffLine = { kind: 'add', content, oldLine: null, newLine: cursor.newLine };
    cursor.newLine += 1;
    return diffLine;
  }
  if (marker === '-') {
    const diffLine: DiffLine = { kind: 'del', content, oldLine: cursor.oldLine, newLine: null };
    cursor.oldLine += 1;
    return diffLine;
  }
  if (marker === '\\') return 'skip';
  return 'stop';
}
