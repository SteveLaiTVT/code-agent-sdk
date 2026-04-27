# Code Agent SDK

Experimental TypeScript SDK for orchestrating coding work across multiple model tiers and agent roles.

The core idea is to treat a coding request as a planned workflow instead of a single model call:

1. a planner turns the user message into a `TaskDAG`
2. Spark workers implement small pure functions and pure components in parallel
3. mini workers compose layout-level pieces
4. GPT-5.5 workers handle screen-level or cross-cutting logic
5. a merge broker validates patches before applying them
6. verifiers and reviewers check the final result without directly editing source

This project is early-stage infrastructure. The mock runner is useful for local validation, while the adapter boundary is designed for real Codex SDK or OpenAI API integration.

## Install

```sh
npm install @steve-life/code-agent-sdk
```

Node.js 18 or newer is required.

## Quick Start

```ts
import { runCodingTask } from "@steve-life/code-agent-sdk";

const result = await runCodingTask(
  "Build a playable snake game. Put pure game logic in small functions.",
  "/path/to/target-repo",
  "main",
);

console.log(result.status);
console.log(result.summary);
```

For UIs that need to render the orchestration process, use the streamed API:

```ts
import { runCodingTaskStreamed } from "@steve-life/code-agent-sdk";

const stream = await runCodingTaskStreamed(
  "Build a playable snake game. Put pure game logic in small functions.",
  "/path/to/target-repo",
  "main",
);

for await (const event of stream.events) {
  if (event.type === "thread.event") {
    console.log(event.threadRunId, event.model, event.sdkEvent);
  }
}

const result = await stream.result;
console.log(result.modelUsage);
```

For a direct single-thread Codex baseline, use `runSingleCodexTask()`.

## Orchestration Model

The SDK separates responsibility by role:

| Role | Default tier | Responsibility |
| --- | --- | --- |
| `planner` | GPT-5.5 xhigh | Understand the requirement, produce `TaskDAG`, contracts, ownership, and review plan |
| `component-worker` | Spark | Implement low-risk pure functions, pure components, validators, formatters, and mappers |
| `layout-worker` | mini | Compose cards, grids, drawers, dialogs, loading, empty, and error UI |
| `screen-worker` | GPT-5.5 high/medium | Implement screen logic, state coordination, routing, permissions, and data loading |
| `reviewer` | GPT-5.5 high/xhigh | Review code and reports without directly modifying source |
| `verifier` | program | Run lint, typecheck, tests, builds, and smoke checks |
| `merge-broker` | program | Validate, merge, and verify worker patches |

Workers never edit the main project root directly. Implementation workers run in isolated workspaces or git worktrees, emit patches, and let `MergeBroker` validate and apply those patches.

## Permission Model

Permissions are derived from:

```txt
AgentRole + ProjectSpace + TaskScope
```

There is no `projectType` switch. File access is path-scoped and every path is checked against `ProjectSpace.root`.

Network permissions are modeled separately:

- `shellNetwork`: command-level network access such as `curl`, `npm install`, `git clone`, `wget`
- `webSearch`: controlled web search or documentation lookup
- `mcpRead`: read-only MCP access such as GitHub, Slack, Jira, or docs
- `mcpWrite`: side-effecting MCP access such as PR creation, issue updates, or messages

Only `shellNetwork` maps to Codex sandbox network access. Tool permissions such as `webSearch`, `mcpRead`, and `mcpWrite` stay at the orchestration layer.

## Local Demo

```sh
npm run agent:demo
```

The demo:

- creates a `ProjectSpace` rooted at the current project
- asks the mock planner for a task-card `TaskDAG`
- runs Spark component tasks in parallel
- generates mock patches
- validates paths through `MergeBroker`
- runs mock verification
- aggregates contract, integration, architecture, and security review reports

## Test

```sh
npm test
```

## Public API

Common entry points:

- `runCodingTask(message, repo, branch, options?)`
- `runCodingTaskStreamed(message, repo, branch, options?)`
- `test(message, repo, branch, options?)`
- `runSingleCodexTask(message, repo, branch)`
- `AgentOrchestrator`
- `MockModelRunner`
- `CodexModelRunnerAdapter`
- `WorkspaceManager`
- `MergeBroker`
- `ReviewAggregator`
- `createCodexOptions`

The package also exports core types such as `TaskContract`, `TaskDAG`, `ProjectSpace`, `TaskScope`, `WorkerResult`, `ReviewResult`, and `OrchestrationResult`.

## Real Model Integration

The adapter boundary is `ModelRunner`:

```ts
export interface ModelRunner {
  runPlanner(requirement: string, context?: ModelRunnerPlannerContext): Promise<TaskDAG>;
  runWorker(input: ModelRunnerWorkerInput): Promise<ModelRunnerWorkerOutput>;
  runReviewer(input: ModelRunnerReviewerInput): Promise<ReviewResult>;
}
```

Use `CodexModelRunnerAdapter` for real Codex SDK execution. The mock runner still uses JSON patch fixtures for deterministic tests and demos; real adapters should run in isolated workspaces and return real patch paths.

## Current Mocked Parts

- `MockModelRunner` returns a fixed task-card `TaskDAG`.
- Mock workers can return JSON patch files instead of real model edits.
- Workspace management supports mock copy mode and a git-worktree strategy boundary.
- Verification commands can be mocked unless `executeVerificationCommands` is enabled.
- Review workers return structured mock review reports unless backed by a real `ModelRunner`.

## Development

```sh
npm install
npm test
npm run agent:demo
```

Before publishing:

```sh
npm run build
npm pack --dry-run
```

## License

MIT
