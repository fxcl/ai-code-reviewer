<!-- English docs: [README.md](./README.md) -->

<div align="center">

# ai-code-reviewer

**在每个 Pull Request 上运行自托管的 AI 代码审查——模型你选、算力你控、规则你定。**

以 GitHub Action 形式运行。模型自带:Claude、OpenAI、本地 Ollama,或任意 OpenAI 兼容端点。隐私优先、免费、开源——CodeRabbit 和 Greptile 的开源平替。

[English](./README.md) · [中文文档](./README.zh-CN.md)

[![CI](https://github.com/fxcl/ai-code-reviewer/actions/workflows/ci.yml/badge.svg)](https://github.com/fxcl/ai-code-reviewer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

</div>

---

往仓库里放一个工作流文件,之后每个 Pull Request 都会被自动审查:评论直接锚定到改动的那一行,带有严重级别、一句话说明,以及在适用时给出**可一键采纳的 `suggestion` 代码块**——在 PR 里点一下就能提交修复。再配一条固定的摘要评论作为总览。无需自建服务器;当你指向本地模型时,代码也不会离开你的内网。

## 效果长什么样

> **说明:** 下面的内容是对输出格式的真实模拟,不是截图。

<!-- TODO(launch): record a real PR demo GIF and replace this mock -->

锚定在改动行上的行内评论:

> 🔴 **用户输入被直接拼接进了 SQL 查询。**
>
> 把 `req.query.id` 拼进语句会让攻击者注入任意 SQL。请改用参数化查询,让驱动来转义这个值。
>
> ```suggestion
>   const user = await db.query('SELECT * FROM users WHERE id = $1', [req.query.id]);
> ```

PR 上的固定摘要评论:

> ### 🤖 AI 代码审查
>
> **3 处问题**,涉及 2 个文件 —— 🔴 1 严重 · 🟠 1 高 · 🟡 1 中
>
> | 严重级别 | 位置 | 问题 |
> |----------|------|------|
> | 🔴 严重 | `api/users.ts:42` | 字符串拼接导致的 SQL 注入 |
> | 🟠 高 | `api/auth.ts:18` | 异步令牌校验缺少 `await` |
> | 🟡 中 | `lib/format.ts:7` | 日期格式化未处理 `null` |
>
> 已审查 2 个文件 · 跳过 1 个(`pnpm-lock.yaml`:锁文件) · 模型 `claude-sonnet-5`

严重级别图例:🔴 严重 · 🟠 高 · 🟡 中 · 🔵 低。

## 30 秒快速上手

1. **添加密钥。** 在仓库中:*Settings → Secrets and variables → Actions → New repository secret*,命名为 `ANTHROPIC_API_KEY`。
2. **添加工作流文件** `.github/workflows/ai-code-review.yml`:

```yaml
name: AI Code Review

on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: fxcl/ai-code-reviewer@v1
        with:
          api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

3. **开一个 Pull Request。** 一分钟内就能看到审查结果。

就这么简单——不需要 `actions/checkout`,不需要服务器,也不需要配置文件。想换模型或换厂商?见下方的[厂商矩阵](#厂商矩阵)。更多用法见 [`examples/`](./examples)。

## 厂商矩阵

设置 `provider`(以及必要时的 `model`、`base_url` 和密钥)即可选用任意厂商。默认使用 Claude。

| 厂商 | `provider` | 常用 `model` | 密钥 / secret | `base_url` | 说明 |
|------|------------|--------------|---------------|------------|------|
| **Anthropic**(默认) | `anthropic` | `claude-sonnet-5` | `ANTHROPIC_API_KEY` | — | 开箱质量最佳。 |
| **OpenAI** | `openai` | `gpt-4o` | `OPENAI_API_KEY` | — | 任意 OpenAI 对话模型。 |
| **Ollama**(本地) | `ollama` | `qwen2.5-coder` | 无 | `http://localhost:11434` | 需自托管 runner;**代码不出内网。** |
| **OpenAI 兼容** | `openai-compatible` | 如 `deepseek-chat` | 该厂商密钥 | 必填,如 `https://api.deepseek.com/v1` | 任意 OpenAI 兼容端点——DeepSeek、GLM、Kimi、Together、Groq、vLLM、LM Studio…… |

模型选择建议(Anthropic):`claude-sonnet-5` 质量/成本平衡(默认),`claude-haiku-4-5` 更省钱,`claude-opus-4-8` 审得最深。完整工作流示例:[`basic.yml`](./examples/basic.yml)、[`ollama.yml`](./examples/ollama.yml)、[`openai-compatible.yml`](./examples/openai-compatible.yml)。

## 配置

有两处可以配置,合并优先级如下:

> **内置默认值  <  `.github/ai-code-reviewer.yml`  <  action 输入**

action 输入始终优先,因此你可以在单个工作流里覆盖仓库配置。

### Action 输入

| 输入 | 默认值 | 说明 |
|------|--------|------|
| `github_token` | `${{ github.token }}` | 用于读取 PR 与发表评论的令牌。 |
| `provider` | `anthropic` | `anthropic` \| `openai` \| `ollama` \| `openai-compatible`。 |
| `model` | `claude-sonnet-5` | 所选厂商的模型名。 |
| `api_key` | — | 厂商 API 密钥。`anthropic`/`openai` 必填,`ollama` 不需要。务必从 secret 传入。 |
| `base_url` | — | 端点 URL。`openai-compatible` 必填;`ollama` 用它覆盖默认地址。 |
| `config_path` | `.github/ai-code-reviewer.yml` | 仓库配置文件路径(从 base 分支读取)。 |
| `language` | `en` | 评论语言:`en` \| `zh-CN`。 |
| `severity_threshold` | `medium` | 低于该级别的问题不报告:`critical` \| `high` \| `medium` \| `low`。 |
| `max_comments` | `20` | 每个 PR 的行内评论数上限。 |
| `include` | *(全部改动文件)* | 逗号/换行分隔的包含 glob。 |
| `exclude` | *(锁文件、`dist/**`、压缩文件、快照)* | 逗号/换行分隔的排除 glob。 |
| `max_files` | `50` | 改动文件超过此数则跳过审查。 |
| `incremental` | `true` | 有新提交时,只审查新增的提交。 |
| `fail_on` | `none` | `none` \| `critical` —— 出现严重问题时是否让 check 失败。 |
| `concurrency` | `4` | 并发模型调用数。 |

**输出:** `findings_count`(报告的问题总数)和 `critical_count`(严重问题数)——可在后续工作流步骤中使用。

### 仓库配置文件

提交 `.github/ai-code-reviewer.yml` 可让所有 PR 共享配置。它从 **base 仓库的默认分支**读取,因此 fork 的 PR 无法篡改(见[隐私与安全](#隐私与安全))。完整带注释示例见 [`examples/ai-code-reviewer.yml`](./examples/ai-code-reviewer.yml)。

```yaml
provider: anthropic            # anthropic | openai | ollama | openai-compatible
model: claude-sonnet-5
base_url: ""                   # 仅 openai-compatible / ollama 需要

review:
  language: zh-CN              # en | zh-CN
  severity_threshold: medium   # critical | high | medium | low
  max_comments: 20
  include: ["src/**", "packages/**"]
  exclude: ["**/*.lock", "dist/**", "**/__snapshots__/**"]
  incremental: true            # 仅审查新提交
  fail_on: none                # none | critical

rules_file: ".github/review-guidelines.md"   # 可选:自定义审查准则
```

API 密钥绝不从此文件读取,只通过 `api_key` 输入(secret)传入。

## 工作原理

```
PR 打开 / 有新提交
   │
   ▼  通过 GitHub API 拉取 unified diff(无需 checkout)
解析 diff → 按文件分块并带上下文
   │
   ▼  每块一次结构化 LLM 调用(受并发上限限制)
问题(严重级别 · 类别 · 描述 · 理由 · 修复建议 · 置信度)
   │
   ▼  过滤:严重级门槛 · 置信度 · 去重 · 按 max_comments 截断
行内评论  +  固定摘要评论
```

- **结构化输出。** 每条问题都通过厂商的 tool/function calling 接口返回,机器可解析,并锚定到真实的改动行——而非自由发挥的文本。
- **天然低噪声。** 低于严重级门槛或置信度门槛的问题会被丢弃,重复项会被合并,数量有上限,PR 不会被评论淹没。
- **重跑幂等。** 摘要评论会记录已审查的 head SHA;对同一提交重跑会直接跳过,而不是重复刷评论。
- **增量审查。** 有新提交时只审查新增的提交(用 `incremental` 开关控制)。
- **诚实截断。** PR 过大时会限制文件/分块数量,并在摘要里明确说明——绝不悄悄丢弃改动。

## 隐私与安全

- **密钥自带、模型自带。** 不经过任何我们运营的第三方服务中转。配合自托管 runner 上的 `provider: ollama`,**代码和 diff 都不出内网。**
- **配置防篡改。** 配置文件和 `rules_file` 从 **base 仓库的默认分支**读取,而非 PR 分支——因此恶意 fork PR 无法改写自己的审查设置。
- **密钥保密。** API 密钥只通过 GitHub secrets 传入,并在日志中被掩码;绝不从仓库配置文件读取。
- **绝不执行你的代码。** 它只通过 GitHub API 读取 diff 并发给你选定的模型,不会 checkout、构建或运行 PR。
- **最小权限。** 工作流只需 `contents: read` 和 `pull-requests: write`。
- **公开仓库的 fork PR(重要):** 对于来自 fork 的 `pull_request` 事件,GitHub 不会向工作流暴露仓库 secrets。因此在公开仓库上,同仓库分支的 PR 能正常审查,而 fork PR 因拿不到 `api_key` 会被跳过。这是 GitHub 平台的限制而非 bug——用 `pull_request_target` 绕开会重新引入 fork 篡改风险,不建议这么做。

## ai-code-reviewer 与 CodeRabbit / Greptile 对比

| | **ai-code-reviewer** | CodeRabbit | Greptile |
|---|:---:|:---:|:---:|
| 开源(MIT) | ✅ | ❌ | ❌ |
| 自托管 / 跑在你的 CI 里 | ✅ | ❌(SaaS) | ❌(SaaS) |
| 模型自带 | ✅ | ❌ | ❌ |
| 本地模型(Ollama) | ✅ | ❌ | ❌ |
| 代码留在自己的基础设施内 | ✅(用本地模型) | ❌ | ❌ |
| 行内评论 + `suggestion` 块 | ✅ | ✅ | ✅ |
| 价格 | 免费(只付你自己的模型用量) | 付费 SaaS | 付费 SaaS |

CodeRabbit 和 Greptile 是成熟的商业产品,拥有本项目并不追求的能力(对话、深度全仓上下文、看板)。ai-code-reviewer 用这些广度换来了开源、可自托管、模型无关——当你要的是掌控力、隐私和"没有按人头收费"时,它是更合适的选择。

## 常见问题

**每个 PR 的审查大概花多少钱?**
你只需支付模型厂商的费用,没有别的开销。一个典型 PR(几百行改动)大致消耗数万输入 token、几千输出 token,分散在少数几次调用里。按 Anthropic 当前标价,大约是**用 `claude-sonnet-5` 每个 PR 约 0.05–0.20 美元**,用 `claude-haiku-4-5` 只需几**美分**,用本地 Ollama 模型则为 **0 美元**(只花你自己的算力)。实际花费取决于 PR 大小和所选模型。

**私有仓库能用吗?**
能。私有仓库里所有 PR(包括协作者分支的 PR)都能拿到 secrets,审查照常运行。上面说的 fork 密钥限制只针对公开仓库的 fork PR。

**怎么加自定义审查准则?**
在配置里把 `rules_file` 指向仓库中的一个 Markdown 文件,如 `.github/review-guidelines.md`。其内容会从 base 分支读取并注入模型 prompt——适合放团队风格、框架约定,或"始终标记某类问题"。

**怎么跳过某些文件?**
用 `exclude` glob(在配置文件或 `exclude` 输入里)。锁文件、`dist/**`、压缩文件和快照默认已排除。用 `include` 可把审查限定在特定路径(如 `src/**`)。

**能拦截合并吗?**
设 `fail_on: critical`,出现严重问题时让 check 失败。默认 `none`(从不拦截)。

## 路线图

- **深度模式** —— 可选的全仓、Agent 式分析,用于抓跨文件 bug。
- **GitHub App** —— 复用同一套核心引擎的自托管 webhook 服务。
- **CLI** —— 推送前在本地审查 diff。
- **更多平台** —— 支持 GitLab 和 Bitbucket。

## 参与贡献

欢迎贡献。开发环境搭建(pnpm workspaces)、包结构和测试/lint/覆盖率要求见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 许可证

[MIT](./LICENSE) © ai-code-reviewer 贡献者。
