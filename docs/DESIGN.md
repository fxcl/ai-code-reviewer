# AI 代码审查机器人 · 完整设计文档

> 版本:v0.1(设计定稿中） ｜ 日期:2026-07-09 ｜ 语言:TypeScript/Node
> 本文件是本项目的**唯一事实来源(Single Source of Truth)**。后续所有开发以本文档为准;任何决策变更先改本文档再改代码。

---

## 0. 一句话

> 往仓库丢一个工作流文件,每个 Pull Request 都由**你自己掌控的模型**(可本地跑)自动审查,在改动行上留下**可点击采纳的修复建议**,并给一份结构化摘要。
>
> 定位:**CodeRabbit / Greptile 的开源自托管平替** —— 免费、隐私优先、模型可自选。

---

## 1. 为什么做这个(涨星依据)

基于 2026-07 联网检索的结论:

- **AI 相关仓库同比 +178%**(GitHub Octoverse 2025),平台已有 430 万+ LLM 项目;星星几乎全流向 AI/LLM 周边。
- **代码审查是明确的第一大瓶颈**:AI 让代码产出暴增 → 压力下移到维护者,PR 更多、要验证的面更大。开源可自托管的 AI 审查器正好卡在这个痛点上。
- **2026 主旋律 = "开发者不再等大厂,自己造"**:闭源付费工具(CodeRabbit、Greptile)存在 → 开源自托管平替天然有需求。
- **隐私 / 本地优先是强涨星点**:支持 Ollama / 本地模型,击中隐私敏感的开发者群体。
- **爆发方法论(硬数据)**:GitHub Trending 只看短时间涨星;Hacker News 曝光后 24h 平均 +121 星、一周 +289 星。README 顶部一句话价值 + GIF 演示 + 一条命令跑通 + 周二/周三上午(PT)集中发布,是可复现的引爆配方。

**为什么它能爆(可试性 × 普适性 × 演示力)**:
- 普适性:每个有 GitHub 仓库的人都是潜在用户(TAM 极大 → 星星天花板高)。
- 可试性:一个 `.yml` 文件 30 秒接入,零服务器。
- 演示力:PR 里自动冒出带修复建议的评论,GIF 冲击力强,Show HN 天生适配。

---

## 2. 已锁定的关键决策

| # | 决策项 | 选择 | 理由 |
|---|--------|------|------|
| 1 | 首发接入形态 | **GitHub Action 先行** | 摩擦最低、最利于病毒式传播;核心引擎预留给 App/CLI 复用 |
| 2 | 实现语言 | **TypeScript / Node** | Action 原生生态、分发最顺、贡献者最多、维护成本最低 |
| 3 | 模型接入 | **多 provider + 自带 Key(BYO)** | 首发支持 Claude / OpenAI / Ollama / 任意 OpenAI 兼容端点;隐私可本地跑 |
| 4 | 审查引擎路线 | **① 分文件分块 + 轻量上下文** | 便宜、可并行、大 PR 不爆 token;深度模式(路线③)后续插件化接入 |
| 5 | Action 运行时 | **node24 + 打包 dist/index.js**(esbuild) | 启动快、Marketplace 标准做法;v1 不做 Docker(移入 v2 自托管) |
| 6 | 结构化输出通道 | **统一走 tool/function calling** | Anthropic tool_use / OpenAI 及兼容端点 function calling / Ollama format schema,兼容面最大 |
| 7 | 配置文件 | `.github/ai-code-reviewer.yml`,**从 base 仓库默认分支经 API 拉取** | 不依赖 checkout;防止 fork PR 篡改审查配置(安全) |
| 8 | 幂等机制 | **sticky 摘要评论**(HTML 标记记录已审 head SHA)+ 按 SHA 跳过重复 | 重跑不刷屏;增量审查基于记录的 SHA 用 compare API 取新 diff |
| 9 | 项目名 | 工作名 **ai-code-reviewer**(目录/仓库同名) | 描述性名利于搜索;上架/发布前可再定品牌名,内部包名用 `@acr/*` |
| 10 | 包管理 | **pnpm workspaces**(本机 pnpm 11 已就绪) | monorepo 标准;依赖在脚手架阶段一次性锁定 |

---

## 3. 目标用户 & 成功指标

**目标用户**
- 个人开发者 / 小团队:想要免费、可控、隐私的 PR 审查。
- 隐私/合规敏感团队:必须本地模型、数据不出内网。
- 开源维护者:PR 太多审不过来,想要一个"第一道过滤网"。

**成功指标(北极星)**
- 主指标:GitHub Stars(阶段目标:首月 1k+,冲 Trending 首页)。
- 次指标:Marketplace 安装量、活跃仓库数、贡献者数(PR/Issue)。
- 质量指标:审查评论的"被采纳率"(suggestion 被 commit 的比例)、误报率。

---

## 4. 系统架构

**分层原则**:核心引擎与平台解耦,Action 只是最薄的适配层。这样后续 App / CLI 复用同一套核心,零重写。

```
monorepo (pnpm workspaces)
├── packages/
│   ├── core/          # 平台无关的审查引擎(纯逻辑,无 GitHub/env 依赖)
│   ├── llm/           # 模型 provider 抽象 + 各实现
│   └── action/        # GitHub Action 适配层(唯一入口,首发)
│   # 后续:packages/app(自托管 webhook 服务)、packages/cli
├── docs/
│   ├── DESIGN.md      # 本文件(唯一事实来源)
│   └── PLAN.md        # 实现计划(任务分解,开发按此执行)
├── action.yml         # Action 元数据(inputs/outputs/runs: node24 + dist/index.js)
├── dist/index.js      # esbuild 打包产物(随仓库提交,CI 校验新鲜度)
└── ...
```

### 4.1 `core`(审查引擎,平台无关)

**输入**:规范化的 `ReviewRequest`
**输出**:`ReviewResult`

```ts
// 核心类型(设计草案,实现时以此为契约)
interface ReviewRequest {
  meta: { title: string; description: string; baseSha: string; headSha: string; language?: string };
  files: ChangedFile[];        // 解析后的改动文件
  config: ReviewConfig;
  context?: RepoContext;       // 可选:相关定义/周边代码
}
interface ChangedFile { path: string; status: 'added'|'modified'|'deleted'|'renamed'; hunks: Hunk[]; }
interface Hunk { header: string; oldStart: number; newStart: number; lines: DiffLine[]; }

interface ReviewResult { summary: ReviewSummary; findings: Finding[]; truncated: TruncationInfo | null; }
interface Finding {
  file: string; line: number;               // 锚定到改动后的行号
  severity: 'critical'|'high'|'medium'|'low';
  category: string;                          // 如 correctness/security/perf/style
  message: string;                           // 一句话问题
  rationale: string;                         // 为什么是问题
  suggestion?: string;                       // 可直接 commit 的修复(GitHub suggestion 块)
  confidence: number;                        // 0-1,用于过滤
}
```

**子模块**:
- `diff-parser`:把 unified diff 解析成 `ChangedFile[] / Hunk[]`。
- `context-builder`:为每个 hunk 拼装上下文(改动块 + 周边 N 行 + 文件路径 + PR 标题/描述);v1.1 起可加"引用到的定义"。
- `chunker`:按 token 预算把文件/hunk 分块,保证不超模型上下文。
- `prompt-builder`:生成审查 prompt,强制**结构化输出**(JSON schema / tool call),产出机器可解析的 `Finding`。
- `llm-client`:调用 `llm` 包的 provider 抽象。
- `response-parser`:校验并解析结构化输出;非法则一次"修复重试",再失败则跳过该块并记录。
- `finding-filter`:按 severity 阈值过滤、去重、丢弃低 confidence、限制每个 PR 最大评论数、稳定排序。

### 4.2 `llm`(模型抽象)

```ts
interface LLMProvider {
  complete(input: { messages: Message[]; schema: JSONSchema; opts: LLMOpts }): Promise<StructuredOutput>;
}
```
- 实现:`AnthropicProvider` / `OpenAIProvider` / `OllamaProvider` / `OpenAICompatibleProvider`(可配 base_url,覆盖绝大多数第三方端点)。
- 统一强制"结构化输出",屏蔽各家差异。
- 内置重试(指数退避)、超时、token 预算控制。

### 4.3 `action`(GitHub Action 适配层)

- 读取 Action inputs(env)。
- 用 Octokit 拉取 PR 元信息与 diff。
- 组装 `ReviewRequest` → 调 `core` → 拿到 `ReviewResult`。
- 映射为 GitHub Review:`pulls.createReview`,inline `comments[]` 锚定改动行 + summary body。
- **幂等**:重跑时更新上一次 review,而不是重复刷评论。
- **增量**:仅审查自上次 review 以来的新提交(可配)。
- **不阻断合并**(默认):除非显式配置 `fail_on: critical`。

---

## 5. 数据流(Action 首发形态)

```
PR opened / synchronize
        │
        ▼
Action 触发(GitHub Actions runner,容器化)
        │
        ▼
Octokit 拉取 PR 元信息 + unified diff
        │
        ▼
diff-parser → ChangedFile[] / Hunk[]
        │
        ▼
context-builder(改动块 + 周边代码 + PR 标题/描述)
        │
        ▼
chunker(按 token 预算分块)
        │
        ▼
对每块并发调用 LLM(结构化 schema) ──▶ Finding[]
        │
        ▼
finding-filter(阈值/去重/低置信丢弃/数量上限/排序)
        │
        ▼
映射为 GitHub inline 评论 + 摘要
        │
        ▼
createReview(或更新已有 review,幂等)+ 写 Step Summary
```

---

## 6. 审查引擎路线(为何选 ①)

| 路线 | 做法 | 优点 | 缺点 | 采用 |
|---|---|---|---|---|
| **① 分文件分块 + 轻量上下文** | 每改动文件/hunk 单独一次调用,带周边代码 | 便宜、可并行、大 PR 不爆 token、逐行信号好 | 跨文件 bug 需增强 | **v1 默认** |
| ② 整 diff 一次过 | 整个 diff 一个 prompt | 最简单、调用最少 | 大 PR 超 token、颗粒度浅 | 作为小 PR 快速模式(可选) |
| ③ 全仓 RAG / Agent 式 | 模型按需拉取任意文件深挖 | 审得最深、抓跨文件问题 | 复杂、慢、贵 | **v2 深度模式**(插件化) |

引擎接口对三条路线保持一致,后续切换/叠加不改上层。

---

## 7. 配置

支持 `.github/ai-code-reviewer.yml` 与 Action inputs 两种;优先级:**默认值 < 配置文件 < inputs**。
配置文件从 **base 仓库默认分支**经 GitHub API 拉取(不依赖 checkout,且 fork PR 无法篡改审查配置)。

```yaml
# .github/ai-code-reviewer.yml
provider: anthropic            # anthropic | openai | ollama | openai-compatible
model: claude-sonnet-5         # 默认审查模型(平衡质量/成本)
base_url: ""                   # openai-compatible / ollama 时使用
# api_key 只走 secrets,绝不写进文件

review:
  language: zh-CN              # 审查评论语言(中文社区友好,涨星点)
  severity_threshold: medium   # 低于该级别不评论
  max_comments: 20             # 每个 PR 最多评论数(防刷屏)
  include: ["src/**", "packages/**"]
  exclude: ["**/*.lock", "dist/**", "**/__snapshots__/**"]
  incremental: true            # 仅审新增提交
  fail_on: none                # none | critical —— 是否让 check 失败

rules_file: ".github/review-guidelines.md"   # 可选:项目自定义审查准则
```

**模型默认策略**:
- 默认:`claude-sonnet-5`(质量/成本平衡)。
- 省钱模式:`claude-haiku-4-5`。
- 深度模式(v2):`claude-opus-4-8`。
- 本地/隐私:`ollama` + 任意开源权重模型。
- 也支持任意 `openai-compatible` 端点(GLM、Kimi、DeepSeek 等第三方)。

---

## 8. 输出 / UX

- **Inline 评论**:锚定改动行,每条 = 严重级 emoji + 一句话问题 + 为什么 +(可选)修复建议。
- **修复建议用 GitHub `suggestion` 块**:用户点 "Commit suggestion" 即可采纳,采纳率是核心质量指标。
- **摘要 review body**:总览 + 各级别计数 + Top 风险;干净则直接 "LGTM ✅"。
- **幂等**:重跑更新同一条 review,不刷屏。
- **i18n**:审查评论语言可配(首发中英文;中文对国内开发者社区涨星有利)。
- **零噪声原则**:低置信、纯风格类默认压制,聚焦真 bug 与安全问题。

---

## 9. 错误处理(显式,不静默)

| 情况 | 处理 |
|---|---|
| API Key 缺失/非法 | Step Summary 明确报错,不含糊崩整个 workflow |
| LLM 限流/超时 | 指数退避重试;最终失败则发部分结果 + 注明 |
| LLM 输出非法 JSON | schema 校验 + 一次修复重试,再失败跳过该块并记录 |
| 超大 PR | 限制文件/hunk 数,在摘要**显式注明截断**(绝不静默截断) |
| 是否阻断合并 | 默认不阻断;仅 `fail_on: critical` 时对 critical 失败 |

---

## 10. 测试策略(目标覆盖率 ≥ 80%,TDD)

- **单元**:diff-parser、prompt-builder、response-parser/校验、finding-filter、各 provider(mock HTTP)。
- **集成**:golden PR 夹具 → 录制的结构化 LLM 响应(fake provider 返回定值)→ 断言 finding→评论映射正确。
- **E2E**:测试仓库 + `nektos/act` 或沙盒仓库真实 workflow,验证 Action 能发出 review。
- 控制台**零警告**;CI 跑 lint + typecheck + test + coverage。

---

## 11. 目录结构(仓库骨架)

```
ai-code-reviewer/
├── action.yml
├── dist/index.js               # esbuild 打包产物(随仓库提交,CI 校验新鲜度)
├── package.json                # pnpm workspace 根
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── packages/
│   ├── core/
│   │   ├── src/{diff-parser,context-builder,chunker,prompt-builder,response-parser,finding-filter,index}.ts
│   │   └── test/
│   ├── llm/
│   │   ├── src/{provider,anthropic,openai,ollama,openai-compatible,index}.ts
│   │   └── test/
│   └── action/
│       ├── src/{main,github,mapper,config}.ts
│       └── test/
├── docs/{DESIGN.md,PLAN.md}
├── examples/                   # 示例 workflow yml + 示例配置
├── .github/workflows/ci.yml
└── README.md                   # 顶部一句话 + GIF + 3 行 quick start + provider 表 + 对比表
```

---

## 12. 范围控制(v1 · YAGNI)

**v1 做(IN)**
- GitHub Action;多 provider BYO;路线① 分文件审查。
- Inline 评论 + suggestion 块 + 摘要。
- 配置文件;幂等重跑;增量审查;评论语言 i18n;本地/隐私模型。

**v1 不做(OUT,留后续)**
- GitHub App 自托管服务;CLI;深度/Agent 全仓模式。
- GitLab / Bitbucket;Web dashboard;从"已解决评论"学习;自定义规则 DSL。

---

## 13. 路线图

- **v1.0**:Action 首发(上表 IN 项)→ 目标冲 Trending。
- **v1.1**:引用定义级上下文;resolved 评论不重复标记;省钱模式(Haiku)。
- **v2.0**:深度模式(路线③ 全仓 Agent 式);GitHub App 自托管;CLI。
- **v2.x**:GitLab/Bitbucket;dashboard;团队级配置与统计。

---

## 14. 发布 / 推广(星项目,发布即设计的一部分)

- 分发:`uses: <org>/ai-code-reviewer@v1`(node24 + 提交的 dist 打包产物,零拉取延迟)。
- 上架 GitHub Actions Marketplace。
- **杀手级 README**:一句话价值 → 真实 PR 审查的 GIF → 3 行 quick start → provider 对照表 → 隐私说明(本地模型)→ 与闭源工具对比表 + star history 徽章。
- **集中发布**:周二/周三上午(太平洋时间)Show HN + r/programming + dev.to,选一个有点热度的仓库做现场演示。
- 一天内集中拉星以冲 Trending(GitHub Trending 只看短时间窗口)。

---

## 15. 命名(已定工作名)

**工作名:`ai-code-reviewer`**(目录/仓库/Action 同名;描述性名利于搜索发现)。内部 npm 包用 `@acr/*` 短前缀,首发不发布 npm。
上架 Marketplace / 正式发布前如需品牌名,备选保留:`Critique` / `Sift` / `Vet` / `PRoof` / `Lens` / `Sentinel-review`,届时全局替换一次即可。

---

## 16. 实施状态(2026-07-09 更新)

1. ✅ 设计定稿(本文档)。
2. ✅ 实现计划:见 `docs/PLAN.md`。
3. ✅ v1.0 实施完成:三包 TDD 实现(llm 66 / core 90 / action 88 测试,全绿);全包覆盖率 ≥99%(阈值 80);typecheck / eslint 零警告;dist 打包并提交。交叉代码审查 + 安全终审完成:结论"安全、正确、可发布";全部 MEDIUM 发现已修复(auth-timeout 竞态、chunk 预算开销、prompt 注入加固、input 默认值遮蔽配置、dist 新鲜度检查、suggestion 契约、增量回退、token 纵深掩码)。
4. ⏳ 发布准备(用户操作项):创建 GitHub 仓库并推送、README GIF 实录、Marketplace 上架、Show HN 集中发布(见 §14)。

**变更纪律:任何决策变更,先改本文档,再改代码。**
