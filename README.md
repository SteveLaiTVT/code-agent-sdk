# Code Agent SDK

Experimental TypeScript SDK for orchestrating coding work across multiple model
tiers and agent roles.

The SDK treats a coding request as a planned workflow instead of a single model
call. A planner produces a `TaskDAG`, specialized workers implement scoped
pieces in isolated workspaces, a merge broker validates patches, verifiers run
commands, reviewers inspect the result, and the caller receives both the final
result and the raw thread-level trace.

This package is intended for developer tools, internal coding platforms, CI
assistants, and agent runners that need to show how a coding task was planned,
executed, verified, and reviewed.

Chinese documentation is available at
[docs/zh-CN-usage.md](https://github.com/SteveLaiTVT/code-agent-sdk/blob/main/docs/zh-CN-usage.md).

## Status

This project is early-stage infrastructure. The public API is usable, but the
orchestration model is still evolving.

- Package name: `@steve-life/code-agent-sdk`
- Runtime: Node.js 18 or newer
- Language: TypeScript, ESM
- Primary integration boundary: `ModelRunner`
- Real model adapter: `CodexModelRunnerAdapter`
- Local deterministic mode: `MockModelRunner`

## Install

```sh
npm install @steve-life/code-agent-sdk
```

The SDK expects the target project to be a Git repository. Real Codex-backed
runs also require the authentication and environment expected by
`@openai/codex-sdk`.

For local SDK development:

```sh
git clone https://github.com/SteveLaiTVT/code-agent-sdk.git
cd code-agent-sdk
npm install
npm test
```

## Quick Start

Use `runCodingTask()` when you only need the final orchestration result.

```ts
import { runCodingTask } from "@steve-life/code-agent-sdk";

const result = await runCodingTask(
  "Build a playable snake game. Put pure game logic in small functions.",
  "/path/to/target-repo",
  "main",
);

console.log(result.status);
console.log(result.summary);
console.log(result.modelUsage.totals);
```

`runCodingTask(message, repo, branch, options?)` will:

1. verify that `repo` is a Git repository
2. fetch `origin/<branch>` when possible
3. check out `branch`
4. create a `ProjectSpace`
5. run the orchestrator with a real `CodexModelRunnerAdapter`
6. return an `OrchestrationResult`

Run this against a clean working tree when possible. The SDK can apply patches
to the target repo after merge validation succeeds.

## Streamed Runs

Use `runCodingTaskStreamed()` when a UI, CLI, dashboard, or log collector needs
to render the process while it is running.

```ts
import { runCodingTaskStreamed } from "@steve-life/code-agent-sdk";

const stream = await runCodingTaskStreamed(
  "Add a task board screen with loading, empty, and error states.",
  "/path/to/target-repo",
  "main",
);

for await (const event of stream.events) {
  switch (event.type) {
    case "run.started":
      console.log("run", event.runId, event.project.root);
      break;
    case "planner.completed":
      console.log("planned tasks", event.dag.tasks.length);
      break;
    case "task.started":
      console.log("task", event.task.taskId, event.workerId);
      break;
    case "thread.event":
      console.log("thread", event.threadRunId, event.model, event.sdkEvent.type);
      break;
    case "model.usage":
      console.log("usage", event.model, event.usage);
      break;
    case "run.completed":
    case "run.failed":
      console.log(event.result.status, event.result.summary);
      break;
  }
}

const result = await stream.result;
console.log(result.trace);
console.log(result.modelUsage.byModel);
```

The stream exposes orchestration-level events and raw Codex SDK thread events.
This is useful when the caller needs a replayable trace for each planner,
worker, and reviewer thread.

### Manual Plan Review

Manual plan review is opt-in. When enabled, the orchestrator validates the
planner's `TaskDAG`, emits `plan.review.required`, and waits before starting
workers, merge, verification, or review.

```ts
const stream = await runCodingTaskStreamed(
  "Refactor the settings screen.",
  "/path/to/target-repo",
  "main",
  {
    orchestrator: {
      planReview: { mode: "manual" },
    },
  },
);

for await (const event of stream.events) {
  if (event.type === "plan.review.required") {
    renderPlan(event.dag, event.options);
    stream.planReview?.approve();
  }
}
```

The controller supports `approve()`, `revise(feedback)`, and `cancel(reason)`.
`revise()` sends feedback back to the planner and emits a new
`plan.review.required` event for the revised DAG. `cancel()` completes the run
with `status: "cancelled"` and does not create task workspaces or apply patches.
Non-streamed APIs reject manual plan review because they cannot expose the
controller.

### Pre-Merge Validation

Implementation patches are validated before they are merged into the target
project. The SDK does not assume Node, Android, iOS, Flutter, or any other
platform. The planner must set each task's `validationTools` and
`verificationCommands`; those task-level commands run in a temporary validation
workspace. When pre-merge validation is enabled, the SDK treats
`verificationCommands` as patch-level gates and does not replay the same
commands after merge. Use explicit verifier tasks or
`fullVerificationCommands` for repo-wide post-merge checks. The caller can add
extra global commands for stricter gates:

```ts
const stream = await runCodingTaskStreamed(message, repo, "main", {
  orchestrator: {
    preMergeValidation: {
      commands: ["npm run build"],
    },
  },
});
```

If pre-merge validation fails, the task fails and the patch is not merged into
the project. The stream emits `task.validation.completed` with the command
results.

### When To Use Direct Codex vs Plan Mode

Use direct Codex, either through `runSingleCodexTask()` or plain
`@openai/codex-sdk`, when speed matters more than orchestration structure.
Route to full plan mode when you need task boundaries, approval gates, or
artifact-quality traceability.

| Route | Best for | Why |
| --- | --- | --- |
| Direct Codex | Single-file edits, quick bug triage, prompt exploration, tiny refactors, one-shot docs or tests | Lowest overhead and fastest feedback loop |
| Plan mode | Multi-file bugs, risky refactors, shared infra, public API changes, build/config work, security-sensitive tasks | Gives you DAG planning, scoped writes, pre-merge validation, review, and replayable trace |

Practical default:

- Start with direct Codex when the request likely stays within 1 to 2 files and does not need manual approval or audit artifacts.
- Route to plan mode when the task spans modules, needs human plan approval, or should leave a verifiable patch/review trail.
- Hard-route to plan mode for migrations, build tooling changes, shared library contracts, auth/security logic, and regressions that need structured debugging.

## Public API

| API | Purpose |
| --- | --- |
| `runCodingTask(message, repo, branch, options?)` | Run a real Codex-backed orchestration and return the final result. |
| `runCodingTaskStreamed(message, repo, branch, options?)` | Run a real Codex-backed orchestration and expose events while it runs. |
| `test(message, repo, branch, options?)` | Alias for `runCodingTask()`. |
| `runSingleCodexTask(message, repo, branch)` | Run one direct Codex thread as a baseline. |
| `AgentOrchestrator` | Low-level orchestrator class for custom model runners and workspace policies. |
| `MockModelRunner` | Deterministic local model runner for tests and demos. |
| `CodexModelRunnerAdapter` | Real adapter backed by `@openai/codex-sdk`. |
| `WorkspaceManager` | Creates task and review workspaces. |
| `MergeBroker` | Validates and applies worker patches. |
| `ReviewAggregator` | Aggregates reviewer output into a final status. |
| `createCodexOptions` | Builds role-aware sandbox and tool-permission options. |

The package also exports core types such as `TaskContract`, `TaskDAG`,
`ProjectSpace`, `TaskScope`, `WorkerResult`, `ReviewResult`,
`OrchestrationEvent`, `ThreadRunTrace`, `ModelUsageSummary`, and
`OrchestrationResult`.

## Options

```ts
import { runCodingTask } from "@steve-life/code-agent-sdk";

const result = await runCodingTask(
  "Refactor the settings page into smaller components.",
  "/path/to/target-repo",
  "main",
  {
    projectId: "settings-refactor",
    modelConfig: {
      plannerModel: "gpt-5.5",
      componentWorkerModel: "gpt-5.3-codex-spark",
      layoutWorkerModel: "gpt-5.4-mini",
      screenWorkerModel: "gpt-5.5",
      reviewerModel: "gpt-5.5",
    },
    orchestrator: {
      maxSparkWorkers: 4,
      maxMiniWorkers: 2,
      maxGpt55Workers: 1,
      fullVerificationCommands: ["npm test"],
    },
  },
);
```

`RunCodingTaskOptions` fields:

| Field | Description |
| --- | --- |
| `projectId` | Optional stable identifier for the target project. Defaults to the repo directory name. |
| `modelConfig` | Model names used by `CodexModelRunnerAdapter`. |
| `orchestrator` | Partial `AgentOrchestratorOptions` for concurrency, verification, custom model runners, and workspace policies. |

`runCodingTask()` defaults to real Codex-backed execution. If you want a fully
deterministic local run, instantiate `AgentOrchestrator` with `MockModelRunner`
or use the local demo.

## Orchestration Model

The SDK separates responsibility by role.

| Role | Default tier | Responsibility |
| --- | --- | --- |
| `planner` | GPT-5.5 xhigh | Understand the request and produce a `TaskDAG` with contracts, ownership, dependencies, models, and review plan. |
| `component-worker` | Spark | Implement low-risk pure functions, pure components, validators, formatters, and mappers. |
| `layout-worker` | mini | Compose layout-level pieces such as cards, grids, drawers, dialogs, loading states, empty states, and error states. |
| `screen-worker` | GPT-5.5 high/medium | Implement screen logic, state coordination, routing, permissions, data loading, and cross-cutting integration. |
| `verifier` | program | Run lint, typecheck, tests, builds, and smoke checks. |
| `reviewer` | GPT-5.5 high/xhigh | Review code and reports without directly editing source. |
| `merge-broker` | program | Validate, merge, and verify worker patches. |

The planner decides the concrete `task.model` for each task. Model usage is
then collected from streamed thread events and summarized by model in the final
`OrchestrationResult`.

## TaskDAG And Task Contracts

A planner returns a `TaskDAG`.

```ts
interface TaskDAG {
  dagId: string;
  tasks: TaskContract[];
  edges: TaskDAGEdge[];
}
```

Each `TaskContract` defines the worker role, model, file scope, dependencies,
acceptance criteria, validation tools, verification commands, and risk level for
one unit of work.

```ts
interface TaskContract {
  taskId: string;
  title: string;
  role: AgentRole;
  model: string;
  modelTier: ModelTier;
  reasoningEffort: ReasoningEffort;
  objective: string;
  readPaths: string[];
  writePaths: string[];
  forbiddenPaths: string[];
  dependencies: string[];
  acceptanceCriteria: string[];
  validationTools: string[];
  verificationCommands: string[];
  riskLevel: "low" | "medium" | "high" | "critical";
  expectedOutputs: string[];
  notes: string[];
}
```

The orchestrator validates the DAG, checks task scope safety, runs ready tasks
in dependency order, and avoids running overlapping write scopes in the same
parallel batch.

## Result Shape

`OrchestrationResult` is the durable output to store in a database, job log, PR
comment, or build artifact.

| Field | Description |
| --- | --- |
| `status` | Final status: `pass`, `needs_changes`, `reject`, `failed`, or `cancelled`. |
| `dag` | The planner-produced `TaskDAG`. |
| `taskResults` | Worker and verifier results. |
| `mergeResults` | Patch validation and merge results. |
| `verificationResults` | Command-level verification output. |
| `reviewResults` | Structured reviewer reports. |
| `trace` | Replayable thread traces grouped by planner, worker, and reviewer run. |
| `modelUsage` | Token and turn counts grouped by model plus totals. |
| `summary` | Human-readable summary of the run. |

`modelUsage` has both `byModel` and `totals`.

```ts
console.log(result.modelUsage.byModel["gpt-5.5"]);
console.log(result.modelUsage.totals.outputTokens);
```

## Stream Event Reference

The streamed API emits these event families:

| Event | Description |
| --- | --- |
| `run.started` | A new orchestration run started. |
| `planner.started` | Planner thread is about to run. |
| `planner.completed` | Planner produced a `TaskDAG`. |
| `planner.failed` | Planner failed before a valid DAG was produced. |
| `plan.review.required` | Plan review is waiting for caller approval, revision, or cancellation. |
| `plan.review.approved` | Caller approved the current plan revision. |
| `plan.review.revision_requested` | Caller requested a revised plan with feedback. |
| `plan.review.cancelled` | Caller cancelled before implementation started. |
| `task.started` | A worker, verifier, or reviewer task started. |
| `task.completed` | A task completed successfully. |
| `task.failed` | A task failed. |
| `task.validation.completed` | Pre-merge validation finished for a worker patch. |
| `merge.completed` | Merge broker completed patch validation and apply for a task. |
| `verification.completed` | Verification command group completed. |
| `review.completed` | Reviewer produced a structured report. |
| `thread.event` | Raw streamed Codex SDK event for a planner, worker, or reviewer thread. |
| `model.usage` | Usage extracted from a completed turn. |
| `run.completed` | Run completed with a non-failed result. |
| `run.failed` | Run completed in failed state. |

When building a UI, render `thread.event` for detailed timeline visibility and
use higher-level events for task status, DAG visualization, and summary panels.

## Workspace And Merge Flow

Implementation workers do not edit the main project root directly.

The default `runCodingTask()` path uses:

- `WorkspaceManager({ strategy: "git-worktree", keepWorkspaces: true })`
- `MergeBroker`
- `CodexModelRunnerAdapter`
- `executeVerificationCommands: true`

The flow is:

1. create an isolated task workspace
2. run the worker in that workspace
3. generate a patch from the worker workspace
4. run task-level pre-merge validation in a temporary validation workspace
5. validate changed files against `TaskContract.writePaths` and apply the patch only after all gates pass
6. run explicit verifier tasks or configured full verification
7. run reviewers

Generated workspaces live under `.agent-orchestrator/`. Keep this path ignored
in target repositories unless you intentionally want to inspect saved
workspaces.

## Permission Model

Permissions are derived from:

```txt
AgentRole + ProjectSpace + TaskScope
```

There is no `projectType` switch. File access is path-scoped and every path is
checked against `ProjectSpace.root`.

Network permissions are modeled separately:

- `shellNetwork`: command-level network access such as `curl`, `npm install`,
  `git clone`, or `wget`
- `webSearch`: controlled web search or documentation lookup
- `mcpRead`: read-only MCP access such as GitHub, Slack, Jira, or docs
- `mcpWrite`: side-effecting MCP access such as PR creation, issue updates, or
  messages

Only `shellNetwork` maps to Codex sandbox network access. Tool permissions such
as `webSearch`, `mcpRead`, and `mcpWrite` stay at the orchestration layer.

## Mock Runner

The mock runner is useful for tests, demos, and local integration work when you
do not want to call real models.

```ts
import {
  AgentOrchestrator,
  MockModelRunner,
  type ProjectSpace,
} from "@steve-life/code-agent-sdk";

const project: ProjectSpace = {
  projectId: "demo",
  root: process.cwd(),
};

const orchestrator = new AgentOrchestrator({
  modelRunner: new MockModelRunner(),
  executeVerificationCommands: false,
});

const result = await orchestrator.run(
  "Implement a task-card UI workflow.",
  project,
);
```

The mock planner returns a fixed task-card DAG, mock workers return deterministic
patch metadata, and mock reviewers return structured pass reports.

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

## Real Model Integration

The adapter boundary is `ModelRunner`.

```ts
export interface ModelRunner {
  runPlanner(requirement: string, context?: ModelRunnerPlannerContext): Promise<TaskDAG>;
  runWorker(input: ModelRunnerWorkerInput): Promise<ModelRunnerWorkerOutput>;
  runReviewer(input: ModelRunnerReviewerInput): Promise<ReviewResult>;
}
```

Use `CodexModelRunnerAdapter` for real Codex SDK execution. The adapter starts
Codex threads for the planner, workers, and reviewers, consumes
`thread.runStreamed()`, forwards raw thread events into the orchestration
stream, and returns model usage from completed turns.

Custom adapters can implement the same interface for other model providers,
internal routing layers, or offline test harnesses.

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

### Automated npm publishing

Pushes to `main` run the GitHub Actions workflow in
`.github/workflows/publish-npm.yml`.

The workflow:

- installs dependencies with `pnpm install --frozen-lockfile`
- runs `pnpm test`
- checks whether the current `package.json` version already exists on npm
- publishes with `npm publish --access public --provenance` only when that
  version is not published yet

Configure the repository secret `NPM_TOKEN` with an npm automation token before
the first automated release. To release a new package version, update
`package.json`'s `version`, then push or merge the change to `main`.

## Current Mocked Or Experimental Parts

- `MockModelRunner` returns a fixed task-card `TaskDAG`.
- Mock workers can return JSON patch files instead of real model edits.
- Workspace management supports mock copy mode and a git-worktree strategy
  boundary.
- Verification commands can be mocked unless `executeVerificationCommands` is
  enabled.
- Review workers return structured mock review reports unless backed by a real
  `ModelRunner`.
- The orchestration API is still experimental and may change before a stable
  release.

## Operational Notes

- Run against a clean target repository when possible.
- `runCodingTask()` may check out the requested branch in the target repo.
- Real workers run with `networkAccessEnabled: false` by default.
- Planner and reviewer behavior depends on the configured model and adapter.
- Store `result.trace` and `result.modelUsage` if you need auditability,
  replay, or cost reporting.
- Prefer the streamed API for user-facing products so callers can see planning,
  execution, verification, review, and raw thread progress.

## License

MIT
