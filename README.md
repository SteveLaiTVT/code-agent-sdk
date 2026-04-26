# code-agent-sdk

TypeScript SDK playground for a multi-model coding orchestration system.

## Run the demo

```sh
npm run agent:demo
```

The demo builds the project, creates a mock `ProjectSpace` rooted at the current directory, asks the mock planner for a TaskDAG, runs Spark component workers in parallel workspaces, merges mock patches through `MergeBroker`, runs mock verification, and aggregates four mock review agents.

## Use the SDK on a repo

```ts
import { test } from "code-agent-sdk";

const result = await test(
  "Build a playable snake game. Put pure game logic in small functions.",
  "/path/to/target-repo",
  "main",
);
```

`test()` now runs the orchestrated path:

- planner model creates a `TaskDAG`
- `component-worker` tasks run with the Spark model in isolated git worktrees
- `layout-worker` tasks run with the mini model
- `screen-worker` tasks run with GPT-5.5
- worker changes return as patches
- `MergeBroker` validates and applies patches
- verifier and reviewer tasks run after merge

For a direct single-thread Codex baseline, use `runSingleCodexTask()`.

## Run tests

```sh
npm test
```

## Current architecture

- `planner`: GPT-5.5 xhigh contract, mocked by `MockModelRunner.runPlanner`.
- `component-worker`: Spark contract for small pure components/functions, parallelized by `SparkWorkerPool`.
- `layout-worker`: mini contract for layout composition.
- `screen-worker`: GPT-5.5 high/medium contract for screen orchestration.
- `reviewer`: read-only structured reviewers for contract, integration, architecture, and security checks.
- `verifier` and `merge-broker`: programmatic agents.

Permissions are derived from `AgentRole + ProjectSpace + TaskScope`. Network is split into `shellNetwork`, `webSearch`, `mcpRead`, and `mcpWrite`; only `shellNetwork` maps to Codex workspace network access.

## Mocked parts

- Model calls are mocked by `MockModelRunner`.
- Worker code changes are represented as JSON mock patches.
- Workspace creation uses isolated directories under `.agent-orchestrator` instead of real git worktrees.
- Verifier commands default to mock pass unless `executeVerificationCommands` is enabled.

## Real adapter path

Use `CodexModelRunnerAdapter` as the adapter boundary for Codex SDK/OpenAI API:

- `runPlanner` turns the requirement into a structured `TaskDAG`.
- `runWorker` runs the assigned task inside its isolated workspace and returns a patch path.
- `runReviewer` returns a structured `ReviewResult`.
- The mock runner still uses JSON mock patches for local tests and `agent:demo`; the Codex adapter uses real git diffs from isolated worktrees.
- Keep `MergeBroker` as the only path that applies patches to the main project root.
