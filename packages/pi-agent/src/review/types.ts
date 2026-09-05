import type { LLMUsage } from '@acr/pi-agent';

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface DiffLine {
  readonly kind: 'context' | 'add' | 'del';
  readonly content: string;
  /** Line number in the old file; null for added lines. */
  readonly oldLine: number | null;
  /** Line number in the new file; null for deleted lines. */
  readonly newLine: number | null;
}

export interface Hunk {
  readonly header: string;
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly DiffLine[];
}

export interface ChangedFile {
  readonly path: string;
  /** Previous path for renames; null otherwise. */
  readonly oldPath: string | null;
  readonly status: FileStatus;
  readonly binary: boolean;
  readonly hunks: readonly Hunk[];
}

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export const SEVERITY_ORDER: readonly Severity[] = ['critical', 'high', 'medium', 'low'];

export type FindingCategory =
  | 'correctness'
  | 'security'
  | 'performance'
  | 'maintainability'
  | 'style'
  | 'testing'
  | 'docs';

export interface Finding {
  readonly file: string;
  /** New-file line number the finding anchors to (must be an add/context line in the diff). */
  readonly line: number;
  readonly severity: Severity;
  readonly category: FindingCategory;
  /** One-sentence statement of the problem. */
  readonly message: string;
  /** Why this is a problem. */
  readonly rationale: string;
  /** Single-line replacement for the anchored line, or null when not applicable. */
  readonly suggestion: string | null;
  /** Model-reported confidence in [0, 1]. */
  readonly confidence: number;
}

export type CommentLanguage = 'en' | 'zh-CN';

export interface ReviewConfig {
  readonly language: CommentLanguage;
  /** Findings below this severity are dropped. */
  readonly severityThreshold: Severity;
  /** Findings below this confidence are dropped. Default 0.5. */
  readonly minConfidence: number;
  /** Hard cap on reported findings per review. Default 20. */
  readonly maxComments: number;
  /** Picomatch globs; empty array means include all. */
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  /** Files beyond this count are skipped. Default 50. */
  readonly maxFiles: number;
  /** Approximate input-token budget per LLM call. Default 12000. */
  readonly maxTokensPerCall: number;
  /** Optional completion max_tokens override forwarded to the provider. */
  readonly maxCompletionTokens?: number;
  /** Custom review guidelines markdown injected into the prompt, or null. */
  readonly guidelines: string | null;
  /** Concurrent LLM calls. Default 4. */
  readonly concurrency: number;
}

export interface PRMeta {
  readonly title: string;
  readonly description: string;
  readonly baseSha: string;
  readonly headSha: string;
}

export interface ReviewRequest {
  readonly meta: PRMeta;
  readonly files: readonly ChangedFile[];
  readonly config: ReviewConfig;
}

export type SkipReason = 'excluded' | 'binary' | 'deleted' | 'too_large' | 'max_files' | 'llm_error';

export interface SkippedFile {
  readonly path: string;
  readonly reason: SkipReason;
  /** Underlying error detail; currently set only for llm_error. */
  readonly detail?: string;
}

export interface ReviewSummary {
  readonly totalFindings: number;
  readonly bySeverity: Readonly<Record<Severity, number>>;
  readonly filesReviewed: number;
  readonly skipped: readonly SkippedFile[];
  readonly usage: LLMUsage;
}

export interface ReviewResult {
  readonly findings: readonly Finding[];
  readonly summary: ReviewSummary;
}

export const DEFAULT_CONFIG: ReviewConfig = {
  language: 'en',
  severityThreshold: 'medium',
  minConfidence: 0.5,
  maxComments: 20,
  include: [],
  exclude: [
    '**/*.lock',
    '**/pnpm-lock.yaml',
    '**/package-lock.json',
    'dist/**',
    '**/*.min.*',
    '**/__snapshots__/**',
  ],
  maxFiles: 50,
  maxTokensPerCall: 12000,
  guidelines: null,
  concurrency: 4,
};
