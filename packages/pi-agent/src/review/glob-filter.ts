import picomatch from 'picomatch';

import type { ChangedFile, ReviewConfig, SkipReason, SkippedFile } from './types';

type Matcher = (input: string) => boolean;

interface Partitioned {
  readonly kept: ChangedFile[];
  readonly skipped: SkippedFile[];
}

/**
 * Partition changed files into review candidates and skipped files, applying
 * exclude -> include -> deleted -> binary -> maxFiles in that order.
 */
export function partitionFiles(
  files: readonly ChangedFile[],
  config: ReviewConfig,
): Partitioned {
  const isExcluded = picomatch([...config.exclude], { dot: true });
  const isIncluded =
    config.include.length > 0
      ? picomatch([...config.include], { dot: true })
      : null;
  const kept: ChangedFile[] = [];
  const skipped: SkippedFile[] = [];
  for (const file of files) {
    const reason = classify(file, isExcluded, isIncluded);
    if (reason === null) kept.push(file);
    else skipped.push({ path: file.path, reason });
  }

  if (kept.length <= config.maxFiles) return { kept, skipped };
  const overflow = kept.slice(config.maxFiles);
  for (const file of overflow) skipped.push({ path: file.path, reason: 'max_files' });
  return { kept: kept.slice(0, config.maxFiles), skipped };
}

function classify(
  file: ChangedFile,
  isExcluded: Matcher,
  isIncluded: Matcher | null,
): SkipReason | null {
  if (isExcluded(file.path)) return 'excluded';
  if (isIncluded !== null && !isIncluded(file.path)) return 'excluded';
  if (file.status === 'deleted') return 'deleted';
  if (file.binary) return 'binary';
  return null;
}
