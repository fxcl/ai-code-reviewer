import { parse as parseYaml } from 'yaml';

import { DEFAULT_CONFIG } from '@acr/pi-agent/review';
import type { CommentLanguage, ReviewConfig, Severity } from '@acr/pi-agent/review';
import type { ProviderConfig, ProviderKind } from '@acr/pi-agent';
import type { RawInputs } from './inputs';

export type FailOn = 'none' | 'critical';

export interface RuntimeConfig {
  readonly incremental: boolean;
  readonly failOn: FailOn;
  readonly configSource: string;
  readonly warnings: readonly string[];
}

export interface ResolvedConfig {
  readonly reviewConfig: ReviewConfig;
  readonly providerConfig: ProviderConfig;
  readonly runtime: RuntimeConfig;
}

const PROVIDER_KINDS: readonly ProviderKind[] = ['anthropic', 'openai', 'ollama', 'openai-compatible', 'pi-agent'];
const LANGUAGES: readonly CommentLanguage[] = ['en', 'zh-CN'];
const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low'];
const FAIL_ONS: readonly FailOn[] = ['none', 'critical'];

const DEFAULT_PROVIDER: ProviderKind = 'anthropic';
const DEFAULT_MODEL = 'claude-sonnet-5';
const DEFAULT_INCREMENTAL = true;

const KNOWN_TOP_LEVEL: ReadonlySet<string> = new Set([
  'provider',
  'model',
  'base_url',
  'review',
  'rules_file',
]);
const KNOWN_REVIEW: ReadonlySet<string> = new Set([
  'language',
  'severity_threshold',
  'max_comments',
  'include',
  'exclude',
  'incremental',
  'fail_on',
]);

interface FileReview {
  readonly language: string | undefined;
  readonly severityThreshold: string | undefined;
  readonly maxComments: number | undefined;
  readonly include: readonly string[] | undefined;
  readonly exclude: readonly string[] | undefined;
  readonly incremental: boolean | undefined;
  readonly failOn: string | undefined;
}

interface FileConfig {
  readonly provider: string | undefined;
  readonly model: string | undefined;
  readonly baseUrl: string | undefined;
  readonly review: FileReview;
  readonly warnings: readonly string[];
}

const EMPTY_REVIEW: FileReview = {
  language: undefined,
  severityThreshold: undefined,
  maxComments: undefined,
  include: undefined,
  exclude: undefined,
  incremental: undefined,
  failOn: undefined,
};

export function resolveConfig(
  raw: RawInputs,
  fileYaml: string | null,
  rulesContent: string | null,
): ResolvedConfig {
  const file = parseFileConfig(fileYaml, raw.configPath);
  return {
    reviewConfig: mergeReviewConfig(raw, file, rulesContent),
    providerConfig: mergeProviderConfig(raw, file),
    runtime: {
      incremental: raw.incremental ?? file.review.incremental ?? DEFAULT_INCREMENTAL,
      failOn: validateFailOn(raw.failOn ?? file.review.failOn, 'none'),
      configSource: fileYaml !== null ? raw.configPath : 'defaults',
      warnings: file.warnings,
    },
  };
}

export function readRulesFilePath(fileYaml: string | null): string | null {
  if (fileYaml === null) return null;
  const root = asRecord(tryParseYaml(fileYaml));
  if (root === null) return null;
  const rulesFile = root['rules_file'];
  return typeof rulesFile === 'string' && rulesFile.trim() !== '' ? rulesFile : null;
}

function mergeReviewConfig(raw: RawInputs, file: FileConfig, rulesContent: string | null): ReviewConfig {
  return {
    ...DEFAULT_CONFIG,
    language: validateLanguage(raw.language ?? file.review.language, DEFAULT_CONFIG.language),
    severityThreshold: validateSeverity(
      raw.severityThreshold ?? file.review.severityThreshold,
      DEFAULT_CONFIG.severityThreshold,
    ),
    maxComments: raw.maxComments ?? file.review.maxComments ?? DEFAULT_CONFIG.maxComments,
    include: raw.include ?? file.review.include ?? DEFAULT_CONFIG.include,
    exclude: raw.exclude ?? file.review.exclude ?? DEFAULT_CONFIG.exclude,
    maxFiles: raw.maxFiles ?? DEFAULT_CONFIG.maxFiles,
    concurrency: raw.concurrency ?? DEFAULT_CONFIG.concurrency,
    guidelines: rulesContent,
  };
}

function mergeProviderConfig(raw: RawInputs, file: FileConfig): ProviderConfig {
  const provider = validateProvider(raw.provider ?? file.provider ?? DEFAULT_PROVIDER);
  const model = raw.model ?? file.model ?? DEFAULT_MODEL;
  const baseUrl = raw.baseUrl ?? file.baseUrl;
  const config: {
    provider: ProviderKind;
    model: string;
    apiKey?: string;
    baseUrl?: string;
  } = { provider, model };
  if (raw.apiKey !== undefined) config.apiKey = raw.apiKey;
  if (baseUrl !== undefined) config.baseUrl = baseUrl;
  return config;
}

function parseFileConfig(fileYaml: string | null, configPath: string): FileConfig {
  if (fileYaml === null) return emptyFileConfig();
  const parsed = safeParseYaml(fileYaml, configPath);
  if (parsed === null || parsed === undefined) return emptyFileConfig();
  const root = asRecord(parsed);
  if (root === null) {
    throw new Error(`Config file "${configPath}" must be a YAML mapping at the top level.`);
  }
  const warnings: string[] = [];
  collectUnknown(root, KNOWN_TOP_LEVEL, warnings, configPath, '');
  return {
    provider: asString(root['provider']),
    model: asString(root['model']),
    baseUrl: asString(root['base_url']),
    review: readReview(root['review'], warnings, configPath),
    warnings,
  };
}

function readReview(value: unknown, warnings: string[], configPath: string): FileReview {
  const rec = asRecord(value);
  if (rec === null) return EMPTY_REVIEW;
  collectUnknown(rec, KNOWN_REVIEW, warnings, configPath, 'review.');
  return {
    language: asString(rec['language']),
    severityThreshold: asString(rec['severity_threshold']),
    maxComments: asPositiveInt(rec['max_comments']),
    include: asStringArray(rec['include']),
    exclude: asStringArray(rec['exclude']),
    incremental: asBoolean(rec['incremental']),
    failOn: asString(rec['fail_on']),
  };
}

function collectUnknown(
  obj: Record<string, unknown>,
  known: ReadonlySet<string>,
  warnings: string[],
  configPath: string,
  scope: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) {
      warnings.push(`Ignoring unknown config key "${scope}${key}" in "${configPath}".`);
    }
  }
}

function emptyFileConfig(): FileConfig {
  return { provider: undefined, model: undefined, baseUrl: undefined, review: EMPTY_REVIEW, warnings: [] };
}

function validateProvider(value: string): ProviderKind {
  if ((PROVIDER_KINDS as readonly string[]).includes(value)) return value as ProviderKind;
  throw new Error(`Invalid provider "${value}". Expected one of: ${PROVIDER_KINDS.join(', ')}.`);
}

function validateLanguage(value: string | undefined, fallback: CommentLanguage): CommentLanguage {
  if (value === undefined) return fallback;
  if ((LANGUAGES as readonly string[]).includes(value)) return value as CommentLanguage;
  throw new Error(`Invalid language "${value}". Expected one of: ${LANGUAGES.join(', ')}.`);
}

function validateSeverity(value: string | undefined, fallback: Severity): Severity {
  if (value === undefined) return fallback;
  if ((SEVERITIES as readonly string[]).includes(value)) return value as Severity;
  throw new Error(`Invalid severity_threshold "${value}". Expected one of: ${SEVERITIES.join(', ')}.`);
}

function validateFailOn(value: string | undefined, fallback: FailOn): FailOn {
  if (value === undefined) return fallback;
  if ((FAIL_ONS as readonly string[]).includes(value)) return value as FailOn;
  throw new Error(`Invalid fail_on "${value}". Expected one of: ${FAIL_ONS.join(', ')}.`);
}

function safeParseYaml(text: string, configPath: string): unknown {
  try {
    return parseYaml(text) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Config file "${configPath}" is not valid YAML: ${detail}`);
  }
}

function tryParseYaml(text: string): unknown {
  try {
    return parseYaml(text) as unknown;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asPositiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function asStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}
