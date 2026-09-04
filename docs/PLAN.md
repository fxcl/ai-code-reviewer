# ai-code-reviewer 实现计划(v1.0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付可上架 GitHub Actions Marketplace 的开源自托管 AI 代码审查 Action:PR 触发 → 多 provider LLM 审查 → inline 评论 + suggestion + 摘要,覆盖率 ≥80%、零警告。

**Architecture:** pnpm monorepo,三包分层:`@acr/llm`(provider 抽象)、`@acr/core`(平台无关审查引擎)、`@acr/action`(GitHub 适配,唯一入口)。契约(types.ts)在脚手架阶段冻结,`llm` 与 `core` 并行实现,`action` 最后集成,esbuild 打包为提交的 `dist/index.js`(node24 运行时)。

**Tech Stack:** TypeScript 5(strict)、Node 20+、pnpm workspaces、vitest + @vitest/coverage-v8、eslint 9 flat + typescript-eslint(type-checked)、zod、picomatch、yaml、@actions/core、@actions/github、esbuild。

## Global Constraints(每个任务隐含遵守)

- 覆盖率阈值 **80%**(lines/statements/functions/branches,vitest coverage 强制,`types.ts` 纯类型文件除外)。
- `eslint --max-warnings 0`;`tsc --noEmit` 零错误;控制台零警告。
- 编码规范:不可变性优先(readonly、创建新对象)、文件 <800 行、函数 <50 行、嵌套 <4 层、错误显式处理(禁静默吞错)、系统边界验证输入。
- 命名:camelCase 变量/函数,PascalCase 类型,UPPER_SNAKE_CASE 常量。
- 代码/注释/测试名用**英文**(开源国际化);注释密度与周边一致,不写废话注释。
- 提交:`<type>: <description>`,不加共同作者。禁止提交任何密钥。
- TDD:先写失败测试(RED)→ 最小实现(GREEN)→ 重构。
- 并行代理约束:**只写自己包目录内文件,不改根配置,不执行 git commit**(由主线统一提交);依赖已在脚手架锁定,禁止新增依赖。
- HTTP 一律用 Node 20 全局 `fetch`;测试用 `vi.stubGlobal('fetch', …)` mock,禁真实网络调用。
- 日志:`llm`/`core` 包禁 `console.*`;`action` 包仅经 `@actions/core` 输出;API key 一律 `core.setSecret` 掩码,禁止出现在日志/错误消息。

---

## 冻结契约(Frozen Contracts)

脚手架阶段写入,**并行实现期间不得修改**。如实现中发现契约缺陷,回主线统一变更(先改本文档与 DESIGN.md)。

### C1 `packages/llm/src/types.ts`(完整内容)

```ts
export type Role = 'system' | 'user' | 'assistant';

export interface Message {
  readonly role: Role;
  readonly content: string;
}

export interface LLMOpts {
  /** Max output tokens. Default 4096. */
  readonly maxTokens?: number;
  /** Sampling temperature. Default 0. */
  readonly temperature?: number;
  /** Per-request timeout in milliseconds. Default 120000. */
  readonly timeoutMs?: number;
}

export interface StructuredRequest {
  readonly messages: readonly Message[];
  /** JSON Schema describing the desired output object. */
  readonly schema: Readonly<Record<string, unknown>>;
  /** Tool/function name presented to the model, e.g. "report_findings". */
  readonly schemaName: string;
  readonly opts?: LLMOpts;
}

export interface LLMUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface StructuredResponse {
  /** Parsed JSON object returned by the model. Unvalidated: caller validates. */
  readonly output: unknown;
  /** Token usage if the provider reports it. */
  readonly usage: LLMUsage | null;
}

export interface LLMProvider {
  readonly name: string;
  complete(req: StructuredRequest): Promise<StructuredResponse>;
}

export type ProviderKind = 'anthropic' | 'openai' | 'ollama' | 'openai-compatible';

export interface ProviderConfig {
  readonly provider: ProviderKind;
  readonly model: string;
  /** Required for anthropic/openai. Optional for openai-compatible/ollama. */
  readonly apiKey?: string;
  /** Required for openai-compatible. Optional override otherwise. */
  readonly baseUrl?: string;
  /** Max retry attempts for retryable errors. Default 3. */
  readonly maxRetries?: number;
}

export type LLMErrorCode =
  | 'auth'
  | 'rate_limit'
  | 'timeout'
  | 'server'
  | 'bad_response'
  | 'network'
  | 'config';

export class LLMError extends Error {
  readonly code: LLMErrorCode;
  readonly retryable: boolean;

  constructor(message: string, code: LLMErrorCode, retryable: boolean, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LLMError';
    this.code = code;
    this.retryable = retryable;
  }
}
```

### C2 `packages/core/src/types.ts`(完整内容)

```ts
import type { LLMUsage } from '@acr/llm';

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
  exclude: ['**/*.lock', '**/pnpm-lock.yaml', '**/package-lock.json', 'dist/**', '**/*.min.*', '**/__snapshots__/**'],
  maxFiles: 50,
  maxTokensPerCall: 12000,
  guidelines: null,
  concurrency: 4,
};
```

### C3 公开出口(索引契约)

- `@acr/llm` `src/index.ts` 导出:C1 全部 + `createProvider(config: ProviderConfig): LLMProvider` + `withRetry`。
- `@acr/core` `src/index.ts` 导出:C2 全部 + `parseUnifiedDiff(diff: string): ChangedFile[]` + `review(request: ReviewRequest, provider: LLMProvider): Promise<ReviewResult>` + `renderSummaryMarkdown(result: ReviewResult, language: CommentLanguage): string`。

---

## Task 0:仓库脚手架(主线执行)

**Files(Create):** `.gitignore`、`package.json`、`pnpm-workspace.yaml`、`tsconfig.base.json`、`eslint.config.js`、`packages/{llm,core,action}/package.json`、`packages/{llm,core,action}/tsconfig.json`、`packages/{llm,core,action}/vitest.config.ts`、`packages/llm/src/types.ts`(=C1)、`packages/core/src/types.ts`(=C2)、`LICENSE`(MIT)

**要点:**
- root package.json:private,scripts:`typecheck`/`lint`/`test`/`build:action`(pnpm -r + esbuild),devDeps 一次锁定:typescript、vitest、@vitest/coverage-v8、eslint、typescript-eslint、esbuild、@types/node。
- 包依赖:core → `@acr/llm@workspace:*` + zod + picomatch;action → `@acr/core`、`@acr/llm`、`@actions/core`、`@actions/github`、`yaml`。
- 各包 package.json `main/types: src/index.ts`(不构建库,action 由 esbuild 直接打包 TS 源)。
- tsconfig.base:strict、noUncheckedIndexedAccess、module/moduleResolution NodeNext、target ES2022。
- vitest coverage thresholds 80(四项),exclude `src/types.ts`。
- 步骤:写文件 → `pnpm install` → `git init` + 首次提交(含 docs/)。

**验收:** `pnpm install` 成功;`git log` 有 `chore: scaffold pnpm monorepo` 提交。

- [x] 完成(见 git 历史)

---

## Task 1:`@acr/llm`(并行代理 A)

**Files:** Create `packages/llm/src/{retry,anthropic,openai,ollama,factory,index}.ts` + `packages/llm/test/{retry,anthropic,openai,ollama,factory}.test.ts`

**Interfaces:** Consumes C1;Produces `createProvider`、`withRetry`(C3)。

**模块行为规格:**

1. `retry.ts` — `withRetry<T>(fn: () => Promise<T>, opts: { maxRetries: number; baseDelayMs?: number; sleep?: (ms: number) => Promise<void> }): Promise<T>`
   - 仅重试 `LLMError.retryable === true`;非 LLMError 或不可重试立即抛。
   - 指数退避 + full jitter:`delay = random(0, min(8000, baseDelayMs * 2^attempt))`,baseDelayMs 默认 500。
   - `sleep` 可注入(测试注入 spy,断言不真等待);重试耗尽抛最后一个错误。
2. `anthropic.ts` — `AnthropicProvider`:POST `{baseUrl|https://api.anthropic.com}/v1/messages`,headers `x-api-key`、`anthropic-version: 2023-06-01`、`content-type: application/json`;body:model、max_tokens、temperature、system(system 消息合并)、messages(非 system)、`tools:[{name: schemaName, description, input_schema: schema}]`、`tool_choice:{type:'tool',name:schemaName}`。响应取 `content[]` 中 `type==='tool_use'` 块的 `input` 为 output;usage 取 `usage.input_tokens/output_tokens`。无 tool_use 块 → `LLMError('bad_response', retryable=false)`。
3. `openai.ts` — `OpenAIProvider`(同时服务 `openai-compatible`,构造参数含 baseUrl,默认 `https://api.openai.com/v1`):POST `/chat/completions`,`Authorization: Bearer <key>`(key 可选:兼容端点可无鉴权);body:model、messages、temperature、max_tokens、`tools:[{type:'function',function:{name: schemaName, description, parameters: schema}}]`、`tool_choice:{type:'function',function:{name: schemaName}}`。响应取 `choices[0].message.tool_calls[0].function.arguments` 做 `JSON.parse`;parse 失败或缺失 → `bad_response`。usage 取 `usage.prompt_tokens/completion_tokens`。
4. `ollama.ts` — `OllamaProvider`:POST `{baseUrl|http://localhost:11434}/api/chat`,body:model、messages、`stream:false`、`format: schema`、`options:{temperature}`。响应 `message.content` 做 `JSON.parse`;usage 由 `prompt_eval_count/eval_count` 映射,缺失则 null。
5. 共同要求(2-4):HTTP 状态映射 401/403→`auth`(不可重试)、429→`rate_limit`(可)、408→`timeout`(可)、≥500→`server`(可)、fetch reject→`network`(可);`AbortController` 实现 timeoutMs → `timeout`;所有请求经 `withRetry` 包裹;错误消息**不得包含 apiKey**。
6. `factory.ts` — `createProvider(config)`:按 kind 分派;校验必填(anthropic/openai 无 apiKey → `LLMError('config')`;openai-compatible 无 baseUrl → 同)。

**TDD 循环(每模块重复):**
- [ ] 写失败测试(mock fetch,断言 URL/headers/body 结构、输出解析、每类错误映射、retry 行为)
- [ ] `pnpm --filter @acr/llm test` 确认 RED
- [ ] 最小实现 → GREEN
- [ ] 重构(保持函数 <50 行)

**验收:** `pnpm --filter @acr/llm test`(coverage ≥80 全绿)、`pnpm --filter @acr/llm typecheck`、根 `pnpm lint` 对该包零警告。

---

## Task 2:`@acr/core`(并行代理 B)

**Files:** Create `packages/core/src/{diff-parser,glob-filter,chunker,prompt-builder,response-parser,finding-filter,summary,concurrency,reviewer,index}.ts` + `packages/core/test/` 同名测试 + `packages/core/test/fixtures/*.diff`

**Interfaces:** Consumes C1/C2 + `LLMProvider`;Produces `parseUnifiedDiff`、`review`、`renderSummaryMarkdown`(C3)。

**模块行为规格:**

1. `diff-parser.ts` — `parseUnifiedDiff(diff: string): ChangedFile[]`:解析 `diff --git` 段;识别 added/deleted/renamed(`rename from/to`)/modified;`Binary files ... differ` → `binary:true, hunks:[]`;`@@ -a,b +c,d @@` 头解析 + 逐行计算 oldLine/newLine(context 双侧递增、add 仅 new、del 仅 old);忽略 `\\ No newline at end of file`;空输入返回 `[]`;畸形段落跳过该文件不抛(displayed via skipped 由上层处理——parser 只负责能解析的)。fixtures 至少覆盖:单文件修改、新增、删除、重命名、二进制、多 hunk、无结尾换行。
2. `glob-filter.ts` — `partitionFiles(files, config): { kept: ChangedFile[]; skipped: SkippedFile[] }`:顺序应用 exclude(picomatch,dot:true)→ include(空=全含)→ 剔除 `status==='deleted'`(reason `deleted`)与 `binary`(reason `binary`)→ 超过 maxFiles 截断(reason `max_files`)。
3. `chunker.ts` — `chunkFiles(kept, config): { units: ReviewUnit[]; skipped: SkippedFile[] }`;`export interface ReviewUnit { readonly path: string; readonly status: FileStatus; readonly hunks: readonly Hunk[] }`。token 估算 `estimateTokens(s) = ceil(s.length / 4)`;单文件渲染超 maxTokensPerCall 则按 hunk 切分为多 unit;单 hunk 仍超预算 → 该文件 skipped(reason `too_large`)。
4. `prompt-builder.ts` — `buildMessages(unit, meta, config): Message[]` + `FINDINGS_SCHEMA`(JSON Schema 常量:`{findings: Finding[]}`,枚举 severity/category,line 为 integer ≥1,confidence 0-1,suggestion string|null)+ `SCHEMA_NAME = 'report_findings'`。system:资深审查员人设、只报真实问题(正确性/安全/性能优先,风格靠后)、严重级 rubric、confidence 诚实、suggestion 仅当能用**单行**替换锚定行时给出否则 null、输出语言按 config.language。user:PR 标题/描述 + guidelines(如有)+ 文件路径/状态 + hunk 渲染。hunk 渲染格式(锚定行号可引用):add 行 `L{newLine} + {content}`、context 行 `L{newLine}   {content}`、del 行 `     - {content}`,hunk 间以 header 分隔。明确指示:line 必须引用某个 `L{n}` 行号。
5. `response-parser.ts` — zod schema 镜像 FINDINGS_SCHEMA;`parseFindings(output: unknown, unit: ReviewUnit): { findings: Finding[]; error: string | null }`:zod 校验失败返回 error(供修复重试);成功则:强制 `file = unit.path`(模型报错的 path 纠正);line 不在该 unit 的可锚定行集合(add/context 的 newLine)内 → 丢弃该条(不算错误);confidence 夹取到 [0,1]。
6. `finding-filter.ts` — `filterFindings(findings, config): Finding[]`:严重级门槛(按 SEVERITY_ORDER)→ minConfidence → 去重(key `file:line:category` 保留更高严重级/置信)→ 稳定排序(severity → file → line)→ 截断 maxComments。
7. `concurrency.ts` — `mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]>`:结果保序;单项 reject 不中断其余(fn 内部自行 catch,此函数按 Promise.all 语义即可——reviewer 中 fn 永不 reject)。
8. `reviewer.ts` — `review(request, provider)`:partition → chunk → 对每 unit:`provider.complete({messages, schema: FINDINGS_SCHEMA, schemaName})` → parseFindings;校验失败**一次修复重试**(追加 user 消息:`Your previous output failed validation: {error}. Respond again following the schema exactly.`);再失败或 LLMError → 该文件 skipped(reason `llm_error`),**不中断整体**。聚合 findings → filterFindings;usage 累加(null 计 0);summary 统计(filesReviewed = 成功审查的 unit 去重文件数)。
9. `summary.ts` — `renderSummaryMarkdown(result, language)`:en/zh-CN 双语;含总数、各严重级计数表、Top 问题(最多 5 条 `file:line message`)、skipped 分组说明(含 too_large 截断显式披露)、`filesReviewed`。纯函数,无 I/O。

**TDD 循环:** 同 Task 1(每模块 RED → GREEN → 重构;reviewer 用 stub provider 测:正常、校验失败后修复成功、修复仍失败、provider 抛 LLMError、并发上限生效)。

**验收:** `pnpm --filter @acr/core test`(coverage ≥80)、typecheck、lint 零警告。

---

## Task 3:文档与示例(并行代理 C)

**Files:** Create `README.md`、`README.zh-CN.md`、`examples/{basic.yml,ollama.yml,openai-compatible.yml,ai-code-reviewer.yml}`、`CONTRIBUTING.md`

**Interfaces:** Consumes DESIGN.md §7 配置 schema、§14 README 结构、本计划 Task 4 的 action inputs 表(见下);Produces 面向用户的全部文档。

**要点:**
- README.md(英文,主打):一句话价值 → demo 区(占位框架 + `TODO(launch): record real PR demo GIF` 注释,**不伪造截图**;先放一个"审查评论长什么样"的 markdown 示例块)→ 30 秒 Quick Start(完整可粘贴 workflow yml)→ Provider 矩阵表(anthropic/openai/ollama/openai-compatible,含所需 secrets)→ 配置全表(与 DESIGN §7 一致)→ 隐私说明(本地模型数据不出内网)→ 与 CodeRabbit/Greptile 对比表(开源/自托管/BYO 模型/免费)→ FAQ(fork PR 的 secrets 限制、费用估算)→ License MIT。
- README.zh-CN.md 为等价中文版,两者互链。
- examples/basic.yml:`on: pull_request` + `permissions: {contents: read, pull-requests: write}` + `uses: fxcl/ai-code-reviewer@v1` + `api_key: ${{ secrets.ANTHROPIC_API_KEY }}`。ollama.yml 展示 self-hosted runner + base_url;openai-compatible.yml 展示第三方端点;ai-code-reviewer.yml 为完整注释版仓库配置示例。
- CONTRIBUTING.md:pnpm 安装、测试、覆盖率、lint、commit 规范、包结构图。

**验收:** 文件齐全;yml 语法有效(`node -e "require('yaml').parse(...)"` 或等价校验);README 中的配置键与 DESIGN §7 完全一致。

---

## Task 4:`@acr/action` + action.yml + 打包(主线/代理 D,依赖 Task 1+2)

**Files:** Create `packages/action/src/{inputs,config,github,mapper,main,run}.ts`、`packages/action/test/{inputs,config,github,mapper,run}.test.ts`、`action.yml`、`scripts/build-action.mjs`、`dist/index.js`(构建产物)

**Interfaces:** Consumes `@acr/core` 的 `parseUnifiedDiff/review/renderSummaryMarkdown/DEFAULT_CONFIG` 与 `@acr/llm` 的 `createProvider`;Produces GitHub Action 入口。

**action.yml inputs(冻结,2026-07-09 修订):** `github_token`(default `${{ github.token }}`)、`provider`、`model`、`api_key`、`base_url`、`config_path`(default `.github/ai-code-reviewer.yml`)、`language`、`severity_threshold`、`max_comments`、`include`、`exclude`(逗号/换行分隔)、`max_files`、`incremental`、`fail_on`、`concurrency`。outputs:`findings_count`、`critical_count`。`runs: {using: node24, main: dist/index.js}`。branding:`icon: eye, color: purple`。

> **修订记录**:provider/model/incremental/fail_on 不设 action.yml default——GitHub runner 会把 default 注入 INPUT_* env,使 getInput 无法区分"用户显式设置"与"默认值",导致配置文件对应键被静默覆盖。这四项的默认值(anthropic / claude-sonnet-5 / true / none)改由 config.ts 在配置文件合并**之前**作为最底层内置默认;getInput 空串一律视为"未设置"跳过。github_token/config_path 非配置文件键,default 保留。

**模块行为规格:**
1. `inputs.ts` — 读取/解析 inputs(布尔/数字/列表解析,非法值显式报错);`api_key` 立即 `core.setSecret`;api_key 缺省时回退 env(`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`LLM_API_KEY` 按 provider)。
2. `config.ts` — 合并:DEFAULT_CONFIG < 仓库配置文件(yaml,经 GitHub API 从 **base 仓库默认分支**读取,404 视为无配置)< inputs;`rules_file` 指向的 guidelines 同源读取;输出 `{ reviewConfig: ReviewConfig; providerConfig: ProviderConfig; runtime: { incremental: boolean; failOn: 'none'|'critical'; configSource: string } }`;未知键警告(`core.warning`)不失败。
3. `github.ts` — `GitHubClient`(注入 octokit,便于测试):`getPRContext()`(非 pull_request 事件 → 明确 setFailed 文案);`fetchDiff(baseSha?)`(全量:`pulls.get` mediaType diff;增量:`repos.compareCommits`);`getStickyState()`/`upsertStickyComment(body)`(查 `<!-- ai-code-reviewer:sticky` 标记,`issues.updateComment` 或 `createComment`,标记内嵌 `{"sha": "..."}`);`postReview(comments)`(`pulls.createReview` event `COMMENT`;422 时剔除无法锚定的评论重试一次,被剔除的并入摘要"未能锚定"节)。
4. `mapper.ts` — `findingToComment(f, language)`:`{path, line, side:'RIGHT', body}`,body = 严重级 emoji(🔴critical 🟠high 🟡medium 🔵low)+ **message** + rationale + 可选 ```suggestion 块(仅单行);`buildStickyBody(result, meta, language, modelLabel)`:标记 + renderSummaryMarkdown + footer(provider/model)。
5. `run.ts` — 编排(纯逻辑,注入 client/provider/inputs,供测试):sticky sha === headSha → info 跳过;增量且有 sticky sha → compare diff,否则全量;parseUnifiedDiff → review → postReview(空 findings 则不发 review)→ upsertSticky → outputs + `core.summary`;`fail_on: critical` 且存在 critical → `setFailed`;LLMError('auth'/'config') → 直接 setFailed 且文案指向缺失的 secret 名。
6. `main.ts` — 薄入口:组装真实依赖调 `run()`,顶层 catch → setFailed(错误消息经掩码)。

**打包:** `scripts/build-action.mjs` 用 esbuild:entry `packages/action/src/main.ts`,`--bundle --platform=node --target=node24 --format=cjs --outfile=dist/index.js`,license banner。`pnpm build:action` 后提交 dist。

**TDD 循环:** 同前;`run.ts` 集成测试覆盖:首跑全量、重跑同 SHA 跳过、增量新提交、fail_on=critical、auth 失败文案、422 剔除重试。github.ts 用 fake octokit(vi.fn 断言调用参数)。

**验收:** 包测试 coverage ≥80;`pnpm build:action` 产出 dist 且 `node --check dist/index.js` 通过;typecheck/lint 零警告。

---

## Task 5:CI + 全量验证(主线)

**Files:** Create `.github/workflows/ci.yml`

**要点:** push/PR 触发;jobs:pnpm + node22 工具链 → install(frozen-lockfile)→ `pnpm typecheck` → `pnpm lint` → `pnpm test`(coverage 阈值即门禁)→ `pnpm build:action` → `git diff --exit-code dist/`(dist 新鲜度)。

**全量验证(本机跑,全绿才算完成):**
```bash
pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm -r test && pnpm build:action && git diff --exit-code dist/
```

- [ ] 全绿;控制台零警告

---

## Task 6:代码审查 + 安全审查(主线,强制)

- [ ] `code-review`(高标准)全量审查;CRITICAL/HIGH 必修,MEDIUM 酌情
- [ ] `security-review`:密钥处理(日志掩码/不落盘)、fork PR 注入面(config 取 base 分支)、prompt injection 缓解说明、GITHUB_TOKEN 最小权限(README 中 permissions 块)、不执行被审代码
- [ ] 修复后回归 Task 5 全量验证

---

## Task 7:收尾(主线)

- [ ] 删除临时/散落文件,确认无冗余代码
- [ ] DESIGN.md §16 状态更新为已完成项打 ✅
- [ ] 逻辑分块提交(scaffold/llm/core/docs/action/ci 各自独立 commit,`<type>: <description>`)
- [ ] Gitee/GitHub 远程:本地仓库就绪;远程仓库需用户创建后 `git remote add` + push(向用户报告)
- [ ] 向用户交付:运行说明 + 发布(launch)检查清单

## Self-Review 记录

- 规格覆盖:DESIGN §4(三包架构)→ Task 0/1/2/4;§5 数据流 → Task 2.8 + 4.5;§7 配置 → Task 4.2 + C2 DEFAULT_CONFIG;§8 输出 UX → Task 4.4 + 2.9;§9 错误处理 → Task 1.5、2.8、4.5;§10 测试 → 各任务 TDD + Task 5;§14 发布 → Task 3 README + Task 7 清单。无缺口。
- 类型一致性:Finding/ReviewConfig/ReviewResult 等在 C1/C2 单点定义,任务仅引用;`ReviewUnit` 在 Task 2.3 定义并被 2.4/2.5 引用,一致。
- 无占位符:demo GIF 为**显式声明的发布期任务**(不伪造),非实现缺口。
