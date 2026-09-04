# @acr/pi-agent

Minimal wrapper around `pi-coding-agent` for **project-scoped agent runtime, RPC streaming, and lifecycle control**.

This package is intentionally thin. It does **not** embed pi internals; it mirrors the same orchestration pattern used by `dscode`, but stripped down for `ai-code-reviewer`.

## Install

```bash
pnpm add @acr/pi-agent
```

Runtime dependency:
- `pi-coding-agent` must be installed and available on `PATH` (or configured via `PI_CODING_AGENT_BIN`).

## Usage

```typescript
import { createPiAgent } from "@acr/pi-agent";

const agent = await createPiAgent({
  cwd: "/Users/vec/workspace/go/ai-code-reviewer",
  provider: "openai-compatible",
  model: "gpt-4o-mini",
  permission: "plan",
  sandbox: "read-only",
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
});

try {
  for await (const event of agent.send("Review the staged diff for bugs and security issues.")) {
    switch (event.type) {
      case "text":
        process.stdout.write(event.text);
        break;
      case "tool_call":
        console.log("tool:", event.name, event.arguments);
        break;
      case "tool_result":
        console.log("result:", event.output);
        break;
      case "error":
        console.error("agent error:", event.message);
        break;
    }
  }
} finally {
  await agent.stop();
}
```

## Options

| Option | Required | Description |
|---|---|---|
| `cwd` | yes | Project directory passed to the agent. |
| `provider` | yes | Provider key forwarded to `pi-coding-agent`. |
| `model` | no | Model override. |
| `permission` | no | `plan`, `ask`, `auto`, `full`. |
| `sandbox` | no | `read-only`, `workspace-write`, `danger-full-access`. |
| `apiKey` | no | Provider API key. |
| `baseURL` | no | Provider base URL. |
| `extraArgs` | no | Additional CLI args forwarded to the agent. |

## Notes

- Session metadata is stored under `~/.pi/agent/sessions`.
- If you need IDE-specific extensions, see `dscode/packages/core` for `extension_ui_response` and desktop host wiring.
- For GitHub Action usage, keep the runtime short-lived and avoid background process persistence.
