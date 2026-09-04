import { SEVERITY_ORDER } from './types';
import type {
  CommentLanguage,
  Finding,
  ReviewResult,
  Severity,
  SkipReason,
  SkippedFile,
} from './types';

const SEVERITY_EMOJI: Readonly<Record<Severity, string>> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '🔵',
};

const SKIP_ORDER: readonly SkipReason[] = [
  'too_large',
  'max_files',
  'excluded',
  'binary',
  'deleted',
  'llm_error',
];

interface Labels {
  readonly heading: string;
  readonly summaryLine: (findings: number, files: number) => string;
  readonly severityHeader: readonly [string, string];
  readonly severityNames: Readonly<Record<Severity, string>>;
  readonly topHeading: string;
  readonly clean: string;
  readonly skippedHeading: string;
  readonly reasonNames: Readonly<Record<SkipReason, string>>;
  readonly usage: (input: number, output: number) => string;
}

const LABELS: Readonly<Record<CommentLanguage, Labels>> = {
  en: {
    heading: 'AI Code Review Summary',
    summaryLine: (findings, files) =>
      `**${findings}** finding(s) across **${files}** reviewed file(s).`,
    severityHeader: ['Severity', 'Count'],
    severityNames: { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' },
    topHeading: 'Top issues',
    clean: 'No issues found. LGTM ✅',
    skippedHeading: 'Skipped files',
    reasonNames: {
      too_large: 'Too large — not reviewed',
      max_files: 'Beyond file limit — not reviewed',
      excluded: 'Excluded by config',
      binary: 'Binary',
      deleted: 'Deleted',
      llm_error: 'Provider error — not reviewed',
    },
    usage: (input, output) => `_Token usage: ${input} in / ${output} out._`,
  },
  'zh-CN': {
    heading: 'AI 代码审查摘要',
    summaryLine: (findings, files) =>
      `在 **${files}** 个已审查文件中发现 **${findings}** 处问题。`,
    severityHeader: ['严重级别', '数量'],
    severityNames: { critical: '严重', high: '高', medium: '中', low: '低' },
    topHeading: '主要问题',
    clean: '未发现问题,LGTM ✅',
    skippedHeading: '已跳过的文件',
    reasonNames: {
      too_large: '过大 — 未审查',
      max_files: '超出文件数上限 — 未审查',
      excluded: '被配置排除',
      binary: '二进制文件',
      deleted: '已删除',
      llm_error: '模型调用失败 — 未审查',
    },
    usage: (input, output) => `_Token 用量:输入 ${input} / 输出 ${output}。_`,
  },
};

/** Render a Markdown review summary in the requested language. Pure. */
export function renderSummaryMarkdown(result: ReviewResult, language: CommentLanguage): string {
  const labels = LABELS[language];
  const { summary, findings } = result;
  const sections: string[] = [
    `## ${labels.heading}`,
    labels.summaryLine(summary.totalFindings, summary.filesReviewed),
    renderSeverityTable(summary.bySeverity, labels),
    renderTopIssues(findings, labels),
  ];
  const skipped = renderSkipped(summary.skipped, labels);
  if (skipped !== null) sections.push(skipped);
  sections.push(labels.usage(summary.usage.inputTokens, summary.usage.outputTokens));
  return sections.join('\n\n');
}

function renderSeverityTable(
  bySeverity: Readonly<Record<Severity, number>>,
  labels: Labels,
): string {
  const rows = SEVERITY_ORDER.map(
    (severity) =>
      `| ${SEVERITY_EMOJI[severity]} ${labels.severityNames[severity]} | ${bySeverity[severity]} |`,
  );
  return [
    `| ${labels.severityHeader[0]} | ${labels.severityHeader[1]} |`,
    '| --- | --- |',
    ...rows,
  ].join('\n');
}

function renderTopIssues(findings: readonly Finding[], labels: Labels): string {
  if (findings.length === 0) return `### ${labels.topHeading}\n\n${labels.clean}`;
  const items = findings
    .slice(0, 5)
    .map((finding, index) => `${index + 1}. \`${finding.file}:${finding.line}\` ${finding.message}`);
  return `### ${labels.topHeading}\n${items.join('\n')}`;
}

function renderSkipped(skipped: readonly SkippedFile[], labels: Labels): string | null {
  if (skipped.length === 0) return null;
  const groups = groupByReason(skipped);
  const lines = SKIP_ORDER.filter((reason) => groups.has(reason)).map((reason) => {
    const paths = groups.get(reason) ?? [];
    return `- **${labels.reasonNames[reason]}** (${paths.length}): ${paths.join(', ')}`;
  });
  return `### ${labels.skippedHeading}\n${lines.join('\n')}`;
}

function groupByReason(skipped: readonly SkippedFile[]): Map<SkipReason, string[]> {
  const groups = new Map<SkipReason, string[]>();
  for (const file of skipped) {
    const paths = groups.get(file.reason) ?? [];
    paths.push(file.path);
    groups.set(file.reason, paths);
  }
  return groups;
}
