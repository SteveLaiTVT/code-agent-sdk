# code-agent-sdk

TypeScript SDK playground for a multi-model coding orchestration system.

## Run the demo

```sh
npm run agent:demo
```

The demo builds the project, creates a mock `ProjectSpace` rooted at the current directory, asks the mock planner for a TaskDAG, runs Spark component workers in parallel workspaces, merges mock patches through `MergeBroker`, runs mock verification, and aggregates four mock review agents.

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

- `runPlanner` should turn the requirement into a validated `TaskDAG`.
- `runWorker` should run the assigned task inside its isolated workspace.
- `runReviewer` should return a structured `ReviewResult`.
- Replace mock patch generation with real workspace diff generation while keeping `MergeBroker` as the only path that applies patches to the main project root.
