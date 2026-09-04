<!-- 中文文档见 [README.zh-CN.md](./README.zh-CN.md) · Chinese docs: [README.zh-CN.md](./README.zh-CN.md) -->

<div align="center">

# ai-code-reviewer

**Self-hosted AI code review on every pull request — your model, your infrastructure, your rules.**

Runs as a GitHub Action. Bring your own model — Claude, OpenAI, a local Ollama model, or any OpenAI-compatible endpoint. Private by design, free, and open source: the open alternative to CodeRabbit and Greptile.

[English](./README.md) · [中文文档](./README.zh-CN.md)

[![CI](https://github.com/fxcl/ai-code-reviewer/actions/workflows/ci.yml/badge.svg)](https://github.com/fxcl/ai-code-reviewer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

</div>

---

Drop one workflow file in your repo and every pull request gets an automated review: inline comments anchored to the changed lines, each with a severity, a one-line explanation, and — where it applies — a **one-click `suggestion` block** you can commit straight from the PR. A sticky summary comment gives you the overview. No servers to run, no code leaving your infrastructure when you point it at a local model.

## What it looks like

> **Note:** the blocks below are honest mock-ups of the output format, not screenshots.

<!-- TODO(launch): record a real PR demo GIF and replace this mock -->

An inline comment on a changed line:

> 🔴 **User input is interpolated directly into the SQL query.**
>
> Concatenating `req.query.id` into the statement lets an attacker inject arbitrary SQL. Use a parameterized query so the driver escapes the value.
>
> ```suggestion
>   const user = await db.query('SELECT * FROM users WHERE id = $1', [req.query.id]);
> ```

The sticky summary comment on the PR:

> ### 🤖 AI Code Review
>
> **3 findings** across 2 files — 🔴 1 critical · 🟠 1 high · 🟡 1 medium
>
> | Severity | Location | Finding |
> |----------|----------|---------|
> | 🔴 critical | `api/users.ts:42` | SQL injection via string interpolation |
> | 🟠 high | `api/auth.ts:18` | Missing `await` on async token verification |
> | 🟡 medium | `lib/format.ts:7` | Unhandled `null` in date formatter |
>
> Reviewed 2 files · skipped 1 (`pnpm-lock.yaml`: lockfile) · model `claude-sonnet-5`

Severity legend: 🔴 critical · 🟠 high · 🟡 medium · 🔵 low.

## Quick start (30 seconds)

1. **Add a secret.** In your repo: *Settings → Secrets and variables → Actions → New repository secret*, named `ANTHROPIC_API_KEY`.
2. **Add a workflow file** at `.github/workflows/ai-code-review.yml`:

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

3. **Open a pull request.** The review appears within a minute.

That's it — no `actions/checkout`, no server, no config file required. Want a different model or provider? See the [provider matrix](#providers) below. More recipes live in [`examples/`](./examples).

## Providers

Pick any provider by setting `provider` (and, where needed, `model`, `base_url`, and a key). Claude is the default.

| Provider | `provider` | Typical `model` | Key / secret | `base_url` | Notes |
|----------|------------|-----------------|--------------|------------|-------|
| **Anthropic** (default) | `anthropic` | `claude-sonnet-5` | `ANTHROPIC_API_KEY` | — | Best quality out of the box. |
| **OpenAI** | `openai` | `gpt-4o` | `OPENAI_API_KEY` | — | Any OpenAI chat model. |
| **Ollama** (local) | `ollama` | `qwen2.5-coder` | none | `http://localhost:11434` | Self-hosted runner; **code never leaves your network.** |
| **OpenAI-compatible** | `openai-compatible` | e.g. `deepseek-chat` | provider's key | required, e.g. `https://api.deepseek.com/v1` | Any OpenAI-compatible endpoint — DeepSeek, GLM, Kimi, Together, Groq, vLLM, LM Studio… |

Model tips (Anthropic): `claude-sonnet-5` for the quality/cost balance (default), `claude-haiku-4-5` to save money, `claude-opus-4-8` for the deepest review. Full example workflows: [`basic.yml`](./examples/basic.yml), [`ollama.yml`](./examples/ollama.yml), [`openai-compatible.yml`](./examples/openai-compatible.yml).

## Configuration

There are two places to configure the reviewer, merged in this order:

> **built-in defaults  <  `.github/ai-code-reviewer.yml`  <  action inputs**

Action inputs always win, so you can override the repo config per-workflow.

### Action inputs

| Input | Default | Description |
|-------|---------|-------------|
| `github_token` | `${{ github.token }}` | Token used to read the PR and post comments. |
| `provider` | `anthropic` | `anthropic` \| `openai` \| `ollama` \| `openai-compatible`. |
| `model` | `claude-sonnet-5` | Model name for the chosen provider. |
| `api_key` | — | Provider API key. Required for `anthropic`/`openai`; unused for `ollama`. Always pass it from a secret. |
| `base_url` | — | Endpoint URL. Required for `openai-compatible`; overrides the default for `ollama`. |
| `config_path` | `.github/ai-code-reviewer.yml` | Path to the repo config file (read from the base branch). |
| `language` | `en` | Comment language: `en` \| `zh-CN`. |
| `severity_threshold` | `medium` | Drop findings below this: `critical` \| `high` \| `medium` \| `low`. |
| `max_comments` | `20` | Hard cap on inline comments per PR. |
| `include` | *(all changed files)* | Comma/newline-separated globs to include. |
| `exclude` | *(lockfiles, `dist/**`, minified, snapshots)* | Comma/newline-separated globs to skip. |
| `max_files` | `50` | Skip the review if more than this many files changed. |
| `incremental` | `true` | On new pushes, review only the newly added commits. |
| `fail_on` | `none` | `none` \| `critical` — whether a critical finding fails the check run. |
| `concurrency` | `4` | Number of concurrent model calls. |

**Outputs:** `findings_count` (total findings reported) and `critical_count` (critical findings) — usable in later workflow steps.

### Repo config file

Commit `.github/ai-code-reviewer.yml` for settings shared across all PRs. It is read from the **base repository's default branch**, so fork PRs can't tamper with it (see [Privacy & security](#privacy--security)). Full annotated example: [`examples/ai-code-reviewer.yml`](./examples/ai-code-reviewer.yml).

```yaml
provider: anthropic            # anthropic | openai | ollama | openai-compatible
model: claude-sonnet-5
base_url: ""                   # openai-compatible / ollama only

review:
  language: en                 # en | zh-CN
  severity_threshold: medium   # critical | high | medium | low
  max_comments: 20
  include: ["src/**", "packages/**"]
  exclude: ["**/*.lock", "dist/**", "**/__snapshots__/**"]
  incremental: true            # review only new commits on push
  fail_on: none                # none | critical

rules_file: ".github/review-guidelines.md"   # optional custom guidelines
```

The API key is never read from this file — it only comes from the `api_key` input (a secret).

## How it works

```
PR opened / new commits
   │
   ▼  fetch the unified diff via the GitHub API (no checkout)
parse diff → per-file chunks with surrounding context
   │
   ▼  one structured LLM call per chunk (concurrency-limited)
findings (severity · category · message · rationale · suggestion · confidence)
   │
   ▼  filter: severity threshold · confidence · dedupe · cap at max_comments
inline comments  +  sticky summary comment
```

- **Structured output.** Every finding comes back through the provider's tool/function-calling interface, so it is machine-parseable and anchored to a real changed line — not free-form prose.
- **Low noise by design.** Findings below the severity threshold or the confidence bar are dropped, duplicates are merged, and the count is capped so a PR never gets buried.
- **Idempotent re-runs.** The summary comment records the reviewed head SHA; re-running on the same commit is skipped instead of duplicating comments.
- **Incremental reviews.** On a new push, only the newly added commits are reviewed (toggle with `incremental`).
- **Honest truncation.** On very large PRs the reviewer caps the number of files/chunks and says so explicitly in the summary — it never silently drops changes.

## Privacy & security

- **Bring your own key, bring your own model.** Nothing is proxied through a third-party service we run. With `provider: ollama` on a self-hosted runner, **your code and diffs never leave your network.**
- **Config is tamper-resistant.** The config file and `rules_file` are read from the **base repository's default branch**, not from the PR branch — so a malicious fork PR cannot rewrite its own review settings.
- **Keys stay secret.** The API key is only ever passed via GitHub secrets and is masked in logs. It is never read from the repo config file.
- **The action never executes your code.** It reads the diff through the GitHub API and sends it to your chosen model. It does not check out, build, or run the PR.
- **Least privilege.** The workflow needs only `contents: read` and `pull-requests: write`.
- **Fork PRs on public repos (important):** GitHub does not expose repository secrets to workflows triggered by `pull_request` from a fork. On a public repo, reviews therefore run for PRs from branches in the same repo, but a fork PR will have no `api_key` and the review is skipped. This is a GitHub platform limitation, not a bug — using `pull_request_target` to work around it re-introduces the fork-tampering risk and is not recommended.

## ai-code-reviewer vs. CodeRabbit / Greptile

| | **ai-code-reviewer** | CodeRabbit | Greptile |
|---|:---:|:---:|:---:|
| Open source (MIT) | ✅ | ❌ | ❌ |
| Self-hosted / runs in your CI | ✅ | ❌ (SaaS) | ❌ (SaaS) |
| Bring your own model | ✅ | ❌ | ❌ |
| Local models (Ollama) | ✅ | ❌ | ❌ |
| Code stays in your infrastructure | ✅ (with a local model) | ❌ | ❌ |
| Inline comments + `suggestion` blocks | ✅ | ✅ | ✅ |
| Price | Free (you pay only your own model usage) | Paid SaaS | Paid SaaS |

CodeRabbit and Greptile are mature commercial products with capabilities this project doesn't aim to match (chat, deep whole-repo context, dashboards). ai-code-reviewer trades that breadth for being open, self-hostable, and model-agnostic — the right pick when you want control, privacy, and no per-seat bill.

## FAQ

**How much does a review cost per PR?**
You pay only your model provider; there is no other cost. A typical PR (a few hundred changed lines) uses on the order of tens of thousands of input tokens and a few thousand output tokens across a handful of calls. At current Anthropic list prices that is roughly **$0.05–$0.20 per PR with `claude-sonnet-5`**, a few **cents** with `claude-haiku-4-5`, and **$0** with a local Ollama model (you pay only your own compute). Your exact cost depends on PR size and the model you choose.

**Does it work on private repos?**
Yes. On private repos, all PRs (including from collaborators' branches) have access to secrets, so reviews run normally. The fork-secret limitation above applies only to fork PRs on public repos.

**How do I add custom review guidelines?**
Set `rules_file` in the config to a Markdown file in your repo, e.g. `.github/review-guidelines.md`. Its contents are read from the base branch and injected into the model prompt — good for house style, framework conventions, or "always flag X."

**How do I skip files?**
Use `exclude` globs (in the config file or the `exclude` input). Lockfiles, `dist/**`, minified files, and snapshots are excluded by default. Use `include` to restrict the review to specific paths (e.g. `src/**`).

**Can I block merges on findings?**
Set `fail_on: critical` to fail the check run when a critical finding is reported. The default is `none` (never blocks).

## Roadmap

- **Deep mode** — optional whole-repo, agent-style analysis for cross-file bugs.
- **GitHub App** — a self-hosted webhook service reusing the same core engine.
- **CLI** — review diffs locally before you push.
- **More platforms** — GitLab and Bitbucket support.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the dev setup (pnpm workspaces), the package layout, and the test/lint/coverage bar.

## License

[MIT](./LICENSE) © the ai-code-reviewer contributors.
