import type { LLMProvider, LLMUsage, Message, StructuredRequest } from '@acr/pi-agent';

import { chunkFiles } from './chunker';
import type { ReviewUnit } from './chunker';
import { mapWithConcurrency } from './concurrency';
import { filterFindings } from './finding-filter';
import { partitionFiles } from './glob-filter';
import { FINDINGS_SCHEMA, SCHEMA_NAME, buildMessages, estimatePromptOverhead } from './prompt-builder';
import { parseFindings } from './response-parser';
import type {
  Finding,
  PRMeta,
  ReviewConfig,
  ReviewRequest,
  ReviewResult,
  ReviewSummary,
  Severity,
  SkippedFile,
} from './types';

interface UnitOutcome {
  readonly path: string;
  readonly findings: readonly Finding[];
  readonly usage: LLMUsage | null;
  readonly failed: boolean;
  readonly error?: string;
}

interface Attempt {
  readonly findings: readonly Finding[];
  readonly error: string | null;
  readonly usage: LLMUsage | null;
}

/**
 * Run a review: partition and chunk the files, review each unit with one repair
 * retry on validation failure, and aggregate findings and skips. Unit-level LLM
 * failures skip that file rather than aborting the whole run.
 */
export async function review(
  request: ReviewRequest,
  provider: LLMProvider,
): Promise<ReviewResult> {
  const { config, meta } = request;
  const partition = partitionFiles(request.files, config);
  const chunked = chunkFiles(partition.kept, config, estimatePromptOverhead(meta, config));
  const outcomes = await mapWithConcurrency(chunked.units, config.concurrency, (unit) =>
    reviewUnit(provider, unit, meta, config),
  );
  return aggregate(outcomes, [...partition.skipped, ...chunked.skipped], config);
}

async function reviewUnit(
  provider: LLMProvider,
  unit: ReviewUnit,
  meta: PRMeta,
  config: ReviewConfig,
): Promise<UnitOutcome> {
  const base = buildMessages(unit, meta, config);
  let usage: LLMUsage | null = null;
  try {
    const first = await attempt(provider, base, unit);
    usage = addUsage(usage, first.usage);
    if (first.error === null) return succeed(unit.path, first.findings, usage);
    const repaired = await attempt(provider, [...base, repairMessage(first.error)], unit);
    usage = addUsage(usage, repaired.usage);
    if (repaired.error === null) return succeed(unit.path, repaired.findings, usage);
    return failWith(unit.path, usage, `output validation failed: ${repaired.error}`);
  } catch (error) {
    if (isLLMError(error)) {
      return failWith(unit.path, usage, error instanceof Error ? error.message : String(error));
    }
    throw error;
  }
}

async function attempt(
  provider: LLMProvider,
  messages: readonly Message[],
  unit: ReviewUnit,
): Promise<Attempt> {
  const request: StructuredRequest = {
    messages,
    schema: FINDINGS_SCHEMA,
    schemaName: SCHEMA_NAME,
  };
  const response = await provider.complete(request);
  const parsed = parseFindings(response.output, unit);
  return { findings: parsed.findings, error: parsed.error, usage: response.usage };
}

function repairMessage(error: string): Message {
  return {
    role: 'user',
    content: `Your previous output failed validation: ${error}. Respond again following the schema exactly.`,
  };
}

function succeed(path: string, findings: readonly Finding[], usage: LLMUsage | null): UnitOutcome {
  return { path, findings, usage, failed: false };
}

function failWith(path: string, usage: LLMUsage | null, error?: string): UnitOutcome {
  return { path, findings: [], usage, failed: true, error };
}

function addUsage(accumulated: LLMUsage | null, next: LLMUsage | null): LLMUsage | null {
  if (next === null) return accumulated;
  if (accumulated === null) return next;
  return {
    inputTokens: accumulated.inputTokens + next.inputTokens,
    outputTokens: accumulated.outputTokens + next.outputTokens,
  };
}

/** Duck-typed LLMError check that avoids importing the class at runtime. */
function isLLMError(error: unknown): boolean {
  return error instanceof Error && error.name === 'LLMError';
}

function aggregate(
  outcomes: readonly UnitOutcome[],
  baseSkipped: readonly SkippedFile[],
  config: ReviewConfig,
): ReviewResult {
  const reviewedPaths = new Set<string>();
  const rawFindings: Finding[] = [];
  let usage: LLMUsage | null = null;
  for (const outcome of outcomes) {
    usage = addUsage(usage, outcome.usage);
    if (!outcome.failed) {
      reviewedPaths.add(outcome.path);
      rawFindings.push(...outcome.findings);
    }
  }
  const skipped = [...baseSkipped, ...llmErrorSkips(outcomes, reviewedPaths)];
  const findings = filterFindings(rawFindings, config);
  return { findings, summary: buildSummary(findings, reviewedPaths.size, skipped, usage) };
}

function llmErrorSkips(
  outcomes: readonly UnitOutcome[],
  reviewedPaths: ReadonlySet<string>,
): SkippedFile[] {
  const seen = new Set<string>();
  const skips: SkippedFile[] = [];
  for (const outcome of outcomes) {
    if (!outcome.failed || reviewedPaths.has(outcome.path) || seen.has(outcome.path)) continue;
    seen.add(outcome.path);
    skips.push({ path: outcome.path, reason: 'llm_error' });
  }
  return skips;
}

function buildSummary(
  findings: readonly Finding[],
  filesReviewed: number,
  skipped: readonly SkippedFile[],
  usage: LLMUsage | null,
): ReviewSummary {
  return {
    totalFindings: findings.length,
    bySeverity: countBySeverity(findings),
    filesReviewed,
    skipped,
    usage: usage ?? { inputTokens: 0, outputTokens: 0 },
  };
}

function countBySeverity(findings: readonly Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}
