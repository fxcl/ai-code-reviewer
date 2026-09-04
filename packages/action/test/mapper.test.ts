import { describe, expect, it } from 'vitest';

import type { Finding, PRMeta, ReviewResult } from '@acr/pi-agent/review';

import {
  STICKY_MARKER_PREFIX,
  buildStickyBody,
  findingToComment,
} from '../src/mapper';
import type { ReviewComment } from '../src/mapper';

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    file: 'src/app.ts',
    line: 42,
    severity: 'high',
    category: 'correctness',
    message: 'Off-by-one loop bound',
    rationale: 'The loop reads one element past the end of the array.',
    suggestion: 'for (let i = 0; i < arr.length; i += 1)',
    confidence: 0.83,
    ...overrides,
  };
}

const META: PRMeta = {
  title: 'PR',
  description: 'desc',
  baseSha: 'base123',
  headSha: 'head456',
};

function makeResult(overrides: Partial<ReviewResult['summary']> = {}): ReviewResult {
  return {
    findings: [],
    summary: {
      totalFindings: 0,
      bySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
      filesReviewed: 1,
      skipped: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      ...overrides,
    },
  };
}

describe('findingToComment', () => {
  it('maps a finding with a suggestion block', () => {
    const comment = findingToComment(makeFinding(), 'en');
    expect(comment.path).toBe('src/app.ts');
    expect(comment.line).toBe(42);
    expect(comment.side).toBe('RIGHT');
    expect(comment.body).toContain('🟠 **Off-by-one loop bound**');
    expect(comment.body).toContain('The loop reads one element past the end');
    expect(comment.body).toContain(
      '```suggestion\nfor (let i = 0; i < arr.length; i += 1)\n```',
    );
    expect(comment.body).toContain(
      '<sub>ai-code-reviewer · high · correctness · confidence 83%</sub>',
    );
  });

  it('omits the suggestion block when there is none', () => {
    const comment = findingToComment(makeFinding({ suggestion: null }), 'en');
    expect(comment.body).not.toContain('```suggestion');
  });

  it('localizes the confidence label for zh-CN', () => {
    const comment = findingToComment(makeFinding({ severity: 'critical' }), 'zh-CN');
    expect(comment.body).toContain('🔴 **Off-by-one loop bound**');
    expect(comment.body).toContain('置信度 83%');
  });
});

describe('buildStickyBody', () => {
  it('embeds a parseable marker with the head SHA', () => {
    const body = buildStickyBody(makeResult(), META, 'en', 'anthropic / claude-sonnet-5');
    expect(body.startsWith(STICKY_MARKER_PREFIX)).toBe(true);
    const marker = body.split('\n')[0] ?? '';
    expect(marker).toContain('{"sha":"head456"}');
    expect(body).toContain('AI Code Review Summary');
    expect(body).toContain('Reviewed by: ai-code-reviewer · anthropic / claude-sonnet-5');
  });

  it('renders a dropped-comments section when provided', () => {
    const dropped: ReviewComment[] = [
      { path: 'src/a.ts', line: 3, side: 'RIGHT', body: 'x' },
    ];
    const body = buildStickyBody(makeResult(), META, 'en', 'p / m', { dropped });
    expect(body).toContain('could not be anchored');
    expect(body).toContain('`src/a.ts:3`');
  });

  it('renders a nothing-to-review note for an empty diff', () => {
    const body = buildStickyBody(makeResult(), META, 'zh-CN', 'p / m', { emptyDiff: true });
    expect(body).toContain('无可审查内容');
    expect(body).toContain('审查者');
  });
});
