import { renderSummaryMarkdown } from '@acr/pi-agent/review';
import type { CommentLanguage, Finding, PRMeta, ReviewResult, Severity } from '@acr/pi-agent/review';

/** Opening of the HTML comment that identifies our sticky summary comment. */
export const STICKY_MARKER_PREFIX = '<!-- ai-code-reviewer:sticky';

export interface ReviewComment {
  readonly path: string;
  readonly line: number;
  readonly side: 'RIGHT';
  readonly body: string;
}

export interface StickyOptions {
  readonly dropped?: readonly ReviewComment[];
  /** When true, render a "nothing to review" note instead of a clean summary. */
  readonly emptyDiff?: boolean;
}

const SEVERITY_EMOJI: Readonly<Record<Severity, string>> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '🔵',
};

const CONFIDENCE_LABEL: Readonly<Record<CommentLanguage, string>> = {
  en: 'confidence',
  'zh-CN': '置信度',
};

const DROPPED_HEADING: Readonly<Record<CommentLanguage, string>> = {
  en: 'Comments that could not be anchored to the diff',
  'zh-CN': '未能锚定到 diff 的评论',
};

const REVIEWED_BY: Readonly<Record<CommentLanguage, string>> = {
  en: 'Reviewed by',
  'zh-CN': '审查者',
};

const NOTHING_TO_REVIEW: Readonly<Record<CommentLanguage, string>> = {
  en: '_Nothing to review — no changed files were found in this diff._',
  'zh-CN': '_无可审查内容 — 此次改动中没有可审查的文件。_',
};

/** Map a finding to a GitHub review comment anchored on the new-file side. */
export function findingToComment(finding: Finding, language: CommentLanguage): ReviewComment {
  return {
    path: finding.file,
    line: finding.line,
    side: 'RIGHT',
    body: buildCommentBody(finding, language),
  };
}

/** Build the sticky summary comment body, embedding the reviewed head SHA. */
export function buildStickyBody(
  result: ReviewResult,
  meta: PRMeta,
  language: CommentLanguage,
  providerLabel: string,
  options: StickyOptions = {},
): string {
  const sections: string[] = [markerLine(meta.headSha)];
  if (options.emptyDiff === true) sections.push(NOTHING_TO_REVIEW[language]);
  sections.push(renderSummaryMarkdown(result, language));
  const dropped = options.dropped ?? [];
  if (dropped.length > 0) sections.push(droppedSection(dropped, language));
  sections.push(providerFooter(providerLabel, language));
  return sections.join('\n\n');
}

function buildCommentBody(finding: Finding, language: CommentLanguage): string {
  const parts: string[] = [
    `${SEVERITY_EMOJI[finding.severity]} **${finding.message}**`,
    finding.rationale,
  ];
  if (finding.suggestion !== null) {
    parts.push('```suggestion\n' + finding.suggestion + '\n```');
  }
  parts.push(footer(finding, language));
  return parts.join('\n\n');
}

function footer(finding: Finding, language: CommentLanguage): string {
  const confidence = `${Math.round(finding.confidence * 100)}%`;
  const label = CONFIDENCE_LABEL[language];
  return `<sub>ai-code-reviewer · ${finding.severity} · ${finding.category} · ${label} ${confidence}</sub>`;
}

function markerLine(headSha: string): string {
  return `${STICKY_MARKER_PREFIX} ${JSON.stringify({ sha: headSha })} -->`;
}

function droppedSection(dropped: readonly ReviewComment[], language: CommentLanguage): string {
  const items = dropped.map((comment) => `- \`${comment.path}:${comment.line}\``);
  return `### ${DROPPED_HEADING[language]}\n${items.join('\n')}`;
}

function providerFooter(providerLabel: string, language: CommentLanguage): string {
  return `<sub>${REVIEWED_BY[language]}: ai-code-reviewer · ${providerLabel}</sub>`;
}
