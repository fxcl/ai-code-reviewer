import { createLLMProvider } from '@acr/pi-agent';
import type { LLMProvider, ProviderConfig } from '@acr/pi-agent';
import { parseUnifiedDiff, renderSummaryMarkdown, review } from '@acr/pi-agent/review';
import type { ChangedFile, CommentLanguage, PRMeta, ReviewConfig, ReviewRequest, ReviewResult } from '@acr/pi-agent/review';

import { readRulesFilePath, resolveConfig } from './config';
import type { FailOn, ResolvedConfig } from './config';
import type { PRContext, ReviewClient, StickyState } from './github';
import type { RawInputs } from './inputs';
import { buildStickyBody, findingToComment } from './mapper';
import type { ReviewComment } from './mapper';

export interface RunLogger {
  info(message: string): void;
  warning(message: string): void;
  error(message: string): void;
}

export interface RunDeps {
  readonly inputs: RawInputs;
  readonly client: ReviewClient;
  readonly log: RunLogger;
  readonly setOutput: (name: string, value: string) => void;
  readonly setFailed: (message: string) => void;
  readonly writeSummary: (markdown: string) => Promise<void> | void;
  /** Injectable provider factory; defaults to the real @acr/pi-agent one. */
  readonly providerFactory?: (config: ProviderConfig) => LLMProvider;
}

interface PublishArgs {
  readonly ctx: PRContext;
  readonly resolved: ResolvedConfig;
  readonly result: ReviewResult;
  readonly files: readonly ChangedFile[];
  readonly sticky: StickyState | null;
  readonly language: CommentLanguage;
  readonly providerLabel: string;
}

const EMPTY_RESULT: ReviewResult = {
  findings: [],
  summary: {
    totalFindings: 0,
    bySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
    filesReviewed: 0,
    skipped: [],
    usage: { inputTokens: 0, outputTokens: 0 },
  },
};

/** Orchestrate one review run. All failures resolve to a clean setFailed. */
export async function run(deps: RunDeps): Promise<void> {
  const providerFactory = deps.providerFactory ?? createLLMProvider;
  try {
    await executeReview(deps, providerFactory);
  } catch (error) {
    failWithError(error, deps.inputs.provider, deps.setFailed);
  }
}

async function executeReview(
  deps: RunDeps,
  providerFactory: (config: ProviderConfig) => LLMProvider,
): Promise<void> {
  const ctx = deps.client.context;
  const resolved = await loadConfig(deps);
  const sticky = await deps.client.getStickyState();
  if (sticky !== null && sticky.sha === ctx.headSha) {
    deps.log.info(`Head ${ctx.headSha} already reviewed; skipping.`);
    setZeroOutputs(deps);
    return;
  }
  const language = resolved.reviewConfig.language;
  const providerLabel = `${resolved.providerConfig.provider} / ${resolved.providerConfig.model}`;
  const files = parseUnifiedDiff(await fetchReviewDiff(deps.client, resolved, sticky, deps.log));
  if (files.length === 0) {
    await publishEmpty(deps, ctx, language, providerLabel, sticky);
    return;
  }
  const provider = providerFactory(resolved.providerConfig);
  const result = await review(toRequest(ctx, files, resolved.reviewConfig), provider);
  await publishResult(deps, { ctx, resolved, result, files, sticky, language, providerLabel });
}

async function loadConfig(deps: RunDeps): Promise<ResolvedConfig> {
  const fileYaml = await deps.client.fetchFileFromBaseDefaultBranch(deps.inputs.configPath);
  const rulesPath = readRulesFilePath(fileYaml);
  const rulesContent =
    rulesPath !== null ? await deps.client.fetchFileFromBaseDefaultBranch(rulesPath) : null;
  const resolved = resolveConfig(deps.inputs, fileYaml, rulesContent);
  for (const warning of resolved.runtime.warnings) deps.log.warning(warning);
  return resolved;
}

async function fetchReviewDiff(
  client: ReviewClient,
  resolved: ResolvedConfig,
  sticky: StickyState | null,
  log: RunLogger,
): Promise<string> {
  if (!(resolved.runtime.incremental && sticky !== null)) {
    return client.fetchDiff();
  }
  try {
    return await client.fetchDiffSince(sticky.sha);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log.warning(
      `Incremental diff from ${sticky.sha} failed (${detail}); falling back to a full review.`,
    );
    return client.fetchDiff();
  }
}

async function publishResult(deps: RunDeps, args: PublishArgs): Promise<void> {
  const comments = args.result.findings.map((finding) => findingToComment(finding, args.language));
  const dropped =
    comments.length > 0
      ? (await deps.client.postReview(comments, buildAnchorable(args.files))).dropped
      : [];
  const body = buildStickyBody(args.result, toMeta(args.ctx), args.language, args.providerLabel, {
    dropped,
  });
  await deps.client.upsertSticky(body, args.sticky);
  emitOutputs(deps, args.result);
  await deps.writeSummary(renderSummaryMarkdown(args.result, args.language));
  maybeFail(deps, args.resolved.runtime.failOn, args.result.summary.bySeverity.critical);
}

async function publishEmpty(
  deps: RunDeps,
  ctx: PRContext,
  language: CommentLanguage,
  providerLabel: string,
  sticky: StickyState | null,
): Promise<void> {
  const body = buildStickyBody(EMPTY_RESULT, toMeta(ctx), language, providerLabel, {
    emptyDiff: true,
  });
  await deps.client.upsertSticky(body, sticky);
  setZeroOutputs(deps);
  await deps.writeSummary(renderSummaryMarkdown(EMPTY_RESULT, language));
  deps.log.info('No reviewable files in the diff; recorded sticky and skipped review.');
}

function buildAnchorable(files: readonly ChangedFile[]): (comment: ReviewComment) => boolean {
  const anchors = new Set<string>();
  for (const file of files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.newLine !== null && (line.kind === 'add' || line.kind === 'context')) {
          anchors.add(anchorKey(file.path, line.newLine));
        }
      }
    }
  }
  return (comment) => anchors.has(anchorKey(comment.path, comment.line));
}

function anchorKey(path: string, line: number): string {
  return `${path}:${String(line)}`;
}

function emitOutputs(deps: RunDeps, result: ReviewResult): void {
  deps.setOutput('findings_count', String(result.summary.totalFindings));
  deps.setOutput('critical_count', String(result.summary.bySeverity.critical));
}

function setZeroOutputs(deps: RunDeps): void {
  deps.setOutput('findings_count', '0');
  deps.setOutput('critical_count', '0');
}

function maybeFail(deps: RunDeps, failOn: FailOn, criticalCount: number): void {
  if (failOn === 'critical' && criticalCount > 0) {
    deps.setFailed(`Review found ${String(criticalCount)} critical finding(s); failing per fail_on=critical.`);
  }
}

function toMeta(ctx: PRContext): PRMeta {
  return { title: ctx.title, description: ctx.description, baseSha: ctx.baseSha, headSha: ctx.headSha };
}

function toRequest(
  ctx: PRContext,
  files: readonly ChangedFile[],
  config: ReviewConfig,
): ReviewRequest {
  return { meta: toMeta(ctx), files, config };
}

interface LLMErrorLike {
  readonly name: string;
  readonly code: string;
  readonly message: string;
}

function failWithError(
  error: unknown,
  provider: string | undefined,
  setFailed: (message: string) => void,
): void {
  if (isLLMErrorLike(error)) {
    setFailed(llmErrorMessage(error, provider));
    return;
  }
  setFailed(error instanceof Error ? error.message : String(error));
}

function isLLMErrorLike(error: unknown): error is LLMErrorLike {
  return (
    error instanceof Error &&
    error.name === 'LLMError' &&
    typeof (error as { code?: unknown }).code === 'string'
  );
}

function llmErrorMessage(error: LLMErrorLike, provider: string | undefined): string {
  if (error.code === 'config' || error.code === 'auth') {
    return `${error.message}. Check that the api_key input or ${secretEnvName(provider)} secret is set and valid.`;
  }
  return error.message;
}

function secretEnvName(provider: string | undefined): string {
  switch (provider) {
    case 'anthropic':
      return 'ANTHROPIC_API_KEY';
    case 'openai':
      return 'OPENAI_API_KEY';
    default:
      return 'LLM_API_KEY';
  }
}
