import { renderHunk, renderHunks } from './prompt-builder';
import { estimateTokens } from './tokens';
import type { ChangedFile, FileStatus, Hunk, ReviewConfig, SkippedFile } from './types';

export { estimateTokens } from './tokens';

/**
 * Floor for the hunk budget after subtracting prompt overhead. Keeps huge
 * guidelines from zeroing the budget and skipping every file; a unit this
 * small still reviews fine on typical large-context models.
 */
const MIN_UNIT_BUDGET_TOKENS = 256;

/** A single unit of review: one file, or a hunk-subset of an oversized file. */
export interface ReviewUnit {
  readonly path: string;
  readonly status: FileStatus;
  readonly hunks: readonly Hunk[];
}

interface Chunked {
  readonly units: ReviewUnit[];
  readonly skipped: SkippedFile[];
}

/**
 * Split kept files into review units within the per-call token budget. Files
 * that fit become one unit; oversized files split by hunk. A file with any
 * single hunk larger than the budget is skipped as `too_large`.
 *
 * `overheadTokens` is the estimated fixed prompt scaffolding (system prompt,
 * PR metadata, guidelines) sent with every unit; it is subtracted from the
 * budget so the estimate matches what the provider actually receives.
 */
export function chunkFiles(
  kept: readonly ChangedFile[],
  config: ReviewConfig,
  overheadTokens = 0,
): Chunked {
  // The floor only cushions the overhead subtraction; an explicitly small
  // configured budget is respected as-is.
  const floor = Math.min(MIN_UNIT_BUDGET_TOKENS, config.maxTokensPerCall);
  const budget = Math.max(floor, config.maxTokensPerCall - overheadTokens);
  const units: ReviewUnit[] = [];
  const skipped: SkippedFile[] = [];
  for (const file of kept) {
    if (estimateTokens(renderHunks(file.hunks)) <= budget) {
      units.push(toUnit(file, file.hunks));
      continue;
    }
    const groups = packHunks(file.hunks, budget);
    if (groups === null) {
      skipped.push({ path: file.path, reason: 'too_large' });
      continue;
    }
    for (const group of groups) units.push(toUnit(file, group));
  }
  return { units, skipped };
}

function toUnit(file: ChangedFile, hunks: readonly Hunk[]): ReviewUnit {
  return { path: file.path, status: file.status, hunks };
}

/** Greedily pack hunks into groups within budget; null if a lone hunk exceeds it. */
function packHunks(hunks: readonly Hunk[], budget: number): Hunk[][] | null {
  const groups: Hunk[][] = [];
  let current: Hunk[] = [];
  let currentText = '';
  for (const hunk of hunks) {
    const hunkText = renderHunk(hunk);
    if (estimateTokens(hunkText) > budget) return null;
    const combined = currentText === '' ? hunkText : `${currentText}\n${hunkText}`;
    if (current.length > 0 && estimateTokens(combined) > budget) {
      groups.push(current);
      current = [hunk];
      currentText = hunkText;
    } else {
      current.push(hunk);
      currentText = combined;
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}
