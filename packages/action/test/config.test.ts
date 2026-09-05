import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '@acr/pi-agent/review';

import { readRulesFilePath, resolveConfig } from '../src/config';
import type { RawInputs } from '../src/inputs';

// Defaults model "no explicit input": every config-file-mergeable field is unset
// so tests exercise the built-in-default < file < input precedence.
function baseInputs(overrides: Partial<RawInputs> = {}): RawInputs {
  return {
    githubToken: 'tok',
    provider: undefined,
    model: undefined,
    apiKey: undefined,
    baseUrl: undefined,
    configPath: '.github/ai-code-reviewer.yml',
    language: undefined,
    severityThreshold: undefined,
    maxComments: undefined,
    include: undefined,
    exclude: undefined,
    maxFiles: undefined,
    maxCompletionTokens: undefined,
    incremental: undefined,
    failOn: undefined,
    concurrency: undefined,
    ...overrides,
  };
}

describe('resolveConfig', () => {
  it('returns defaults when there is no config file', () => {
    const resolved = resolveConfig(baseInputs(), null, null);
    expect(resolved.reviewConfig).toEqual({ ...DEFAULT_CONFIG, guidelines: null });
    expect(resolved.providerConfig).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5' });
    expect(resolved.runtime).toEqual({
      incremental: true,
      failOn: 'none',
      configSource: 'defaults',
      warnings: [],
    });
  });

  it('lets inputs override file values', () => {
    const yaml = `
review:
  language: en
  max_comments: 5
`;
    const resolved = resolveConfig(
      baseInputs({ language: 'zh-CN', maxComments: 12 }),
      yaml,
      null,
    );
    expect(resolved.reviewConfig.language).toBe('zh-CN');
    expect(resolved.reviewConfig.maxComments).toBe(12);
    expect(resolved.runtime.configSource).toBe('.github/ai-code-reviewer.yml');
  });

  it('uses config-file provider and model when the inputs are unset', () => {
    const yaml = `
provider: openai
model: gpt-4o
`;
    const resolved = resolveConfig(baseInputs(), yaml, null);
    expect(resolved.providerConfig.provider).toBe('openai');
    expect(resolved.providerConfig.model).toBe('gpt-4o');
  });

  it('lets an explicit provider input win over the config file', () => {
    const resolved = resolveConfig(baseInputs({ provider: 'anthropic' }), 'provider: openai\n', null);
    expect(resolved.providerConfig.provider).toBe('anthropic');
  });

  it('takes incremental and fail_on from the config file when inputs are unset', () => {
    const yaml = `
review:
  incremental: false
  fail_on: critical
`;
    const resolved = resolveConfig(baseInputs(), yaml, null);
    expect(resolved.runtime.incremental).toBe(false);
    expect(resolved.runtime.failOn).toBe('critical');
  });

  it('lets an explicit incremental input win over the config file', () => {
    const resolved = resolveConfig(baseInputs({ incremental: true }), 'review:\n  incremental: false\n', null);
    expect(resolved.runtime.incremental).toBe(true);
  });

  it('applies file values when inputs are absent', () => {
    const yaml = `
base_url: https://file.example.com
review:
  language: zh-CN
  severity_threshold: high
  include: ["src/**"]
  exclude: ["dist/**"]
`;
    const resolved = resolveConfig(baseInputs(), yaml, null);
    expect(resolved.reviewConfig.language).toBe('zh-CN');
    expect(resolved.reviewConfig.severityThreshold).toBe('high');
    expect(resolved.reviewConfig.include).toEqual(['src/**']);
    expect(resolved.reviewConfig.exclude).toEqual(['dist/**']);
    expect(resolved.providerConfig.baseUrl).toBe('https://file.example.com');
  });

  it('sets guidelines from the rules file content', () => {
    const resolved = resolveConfig(baseInputs(), null, '# House rules');
    expect(resolved.reviewConfig.guidelines).toBe('# House rules');
  });

  it('includes apiKey and baseUrl in providerConfig only when present', () => {
    const withKey = resolveConfig(
      baseInputs({ apiKey: 'sk', baseUrl: 'https://x' }),
      null,
      null,
    );
    expect(withKey.providerConfig).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      apiKey: 'sk',
      baseUrl: 'https://x',
    });
  });

  it('collects unknown top-level and review keys as warnings', () => {
    const yaml = `
provider: openai
mystery: 1
review:
  language: en
  bogus: true
`;
    const resolved = resolveConfig(baseInputs(), yaml, null);
    expect(resolved.runtime.warnings).toEqual([
      expect.stringContaining('"mystery"'),
      expect.stringContaining('"review.bogus"'),
    ]);
  });

  it('throws on invalid YAML naming the config path', () => {
    expect(() => resolveConfig(baseInputs(), ': : : not yaml\n  - [', null)).toThrow(
      /\.github\/ai-code-reviewer\.yml" is not valid YAML/,
    );
  });

  it('throws when the top level is not a mapping', () => {
    expect(() => resolveConfig(baseInputs(), '- a\n- b', null)).toThrow(/must be a YAML mapping/);
  });

  it.each([
    ['language', { language: 'fr' }, /Invalid language "fr"/],
    ['severity', { severityThreshold: 'blocker' }, /Invalid severity_threshold "blocker"/],
    ['failOn', { failOn: 'always' }, /Invalid fail_on "always"/],
    ['provider', { provider: 'gemini' }, /Invalid provider "gemini"/],
  ])('rejects invalid enum for %s', (_name, overrides, pattern) => {
    expect(() => resolveConfig(baseInputs(overrides), null, null)).toThrow(pattern);
  });

  it('treats an empty config file as no config', () => {
    const resolved = resolveConfig(baseInputs(), '', null);
    expect(resolved.runtime.warnings).toEqual([]);
    expect(resolved.reviewConfig.language).toBe(DEFAULT_CONFIG.language);
  });
});

describe('readRulesFilePath', () => {
  it('extracts a rules_file path', () => {
    expect(readRulesFilePath('rules_file: .github/rules.md')).toBe('.github/rules.md');
  });

  it('returns null when absent, empty, or unparseable', () => {
    expect(readRulesFilePath(null)).toBeNull();
    expect(readRulesFilePath('provider: openai')).toBeNull();
    expect(readRulesFilePath('rules_file: "   "')).toBeNull();
    expect(readRulesFilePath(': : bad')).toBeNull();
  });
});
