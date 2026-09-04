import { SEVERITY_ORDER } from './types';
import type { Finding, ReviewConfig, Severity } from './types';

/**
 * Apply the severity threshold and confidence floor, dedupe by
 * file:line:category (keeping the strongest), sort stably by
 * severity → file → line, and cap at maxComments.
 */
export function filterFindings(
  findings: readonly Finding[],
  config: ReviewConfig,
): Finding[] {
  const threshold = severityRank(config.severityThreshold);
  const passing = findings.filter(
    (finding) =>
      severityRank(finding.severity) <= threshold &&
      finding.confidence >= config.minConfidence,
  );
  const deduped = dedupe(passing);
  const sorted = [...deduped].sort(compareFindings);
  return sorted.slice(0, config.maxComments);
}

function severityRank(severity: Severity): number {
  return SEVERITY_ORDER.indexOf(severity);
}

function dedupe(findings: readonly Finding[]): Finding[] {
  const byKey = new Map<string, Finding>();
  for (const finding of findings) {
    const key = `${finding.file}:${finding.line}:${finding.category}`;
    const existing = byKey.get(key);
    if (existing === undefined || isStronger(finding, existing)) byKey.set(key, finding);
  }
  return [...byKey.values()];
}

function isStronger(candidate: Finding, current: Finding): boolean {
  const candidateRank = severityRank(candidate.severity);
  const currentRank = severityRank(current.severity);
  if (candidateRank !== currentRank) return candidateRank < currentRank;
  return candidate.confidence > current.confidence;
}

function compareFindings(a: Finding, b: Finding): number {
  const bySeverity = severityRank(a.severity) - severityRank(b.severity);
  if (bySeverity !== 0) return bySeverity;
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  return a.line - b.line;
}
