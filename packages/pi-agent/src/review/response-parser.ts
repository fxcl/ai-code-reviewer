import { z } from 'zod';

import type { ReviewUnit } from './chunker';
import type { Finding } from './types';

const findingSchema = z.object({
  line: z.number().int().min(1),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  category: z.enum([
    'correctness',
    'security',
    'performance',
    'maintainability',
    'style',
    'testing',
    'docs',
  ]),
  message: z.string(),
  rationale: z.string(),
  suggestion: z.string().nullable(),
  confidence: z.number(),
});

const responseSchema = z.object({ findings: z.array(findingSchema) });

interface ParseResult {
  readonly findings: Finding[];
  readonly error: string | null;
}

/**
 * Validate and normalize a model response for one unit. On schema failure an
 * error string is returned for a repair retry. On success, findings are forced
 * onto the unit's file, confidence is clamped, and findings anchored to
 * non-diff lines are dropped (not an error).
 */
export function parseFindings(output: unknown, unit: ReviewUnit): ParseResult {
  const parsed = responseSchema.safeParse(output);
  if (!parsed.success) return { findings: [], error: formatZodError(parsed.error) };

  const anchorable = anchorableLines(unit);
  const findings: Finding[] = [];
  for (const raw of parsed.data.findings) {
    if (!anchorable.has(raw.line)) continue;
    findings.push({
      file: unit.path,
      line: raw.line,
      severity: raw.severity,
      category: raw.category,
      message: raw.message,
      rationale: raw.rationale,
      suggestion: normalizeSuggestion(raw.suggestion),
      confidence: clamp(raw.confidence),
    });
  }
  return { findings, error: null };
}

function anchorableLines(unit: ReviewUnit): Set<number> {
  const lines = new Set<number>();
  for (const hunk of unit.hunks) {
    for (const line of hunk.lines) {
      if (line.kind !== 'del' && line.newLine !== null) lines.add(line.newLine);
    }
  }
  return lines;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Enforce the single-line suggestion contract: a suggestion must be a single
 * physical line that can replace the anchored line. Drop (nullify) anything
 * empty/whitespace-only or spanning multiple lines — better no suggestion than
 * a malformed one.
 */
function normalizeSuggestion(suggestion: string | null): string | null {
  if (suggestion === null) return null;
  if (suggestion.trim() === '' || suggestion.includes('\n')) return null;
  return suggestion;
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join('.');
      return path === '' ? issue.message : `${path}: ${issue.message}`;
    })
    .join('; ');
}
