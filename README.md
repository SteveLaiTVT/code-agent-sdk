# Code Agent SDK

TypeScript SDK for running Codex-backed coding agents with planning,
streaming, scoped workspaces, patch validation, review, and model-usage
visibility.

The package is meant to be embedded by a CLI, web console, CI job, internal dev
platform, or another agent runtime. It is not a demo app and does not ship an
example project.

Chinese documentation is available in
[docs/zh-CN-usage.md](docs/zh-CN-usage.md).

## Install

```sh
npm install @steve-life/code-agent-sdk
```

Runtime requirements:

- Node.js 18 or newer
- ESM runtime
- a local target repo that is already a Git repository
- OpenAI/Codex credentials for real Codex-backed runs

The SDK reads local `.env` values through `createCodexClientOptions()`.
Supported key aliases are `OPENAI_API_KEY` and `OPENAI_KEY`. Supported base URL
aliases are `OPENAI_API_BSSE_URL`, `OPENAI_API_BASE_URL`, `OPENAI_BASE_URL`, and
`OPENAI_URL`.

## Main APIs

| API | Use it when |
| --- | --- |
| `runCodingTask(message, repo, branch, options?)` | You only need the final `OrchestrationResult`. |
| `runCodingTaskStreamed(message, repo, branch, options?)` | You need live events, raw thread visibility, or manual plan review. |
| `runTaskSessionStreamed(input, options?)` | You want a thin streamed Codex thread/session wrapper. |
| `runCodeAgentStreamed(input)` | You want streamed orchestration plus derived Code-Agent artifacts such as report/test-plan output. |
| `AgentOrchestrator` | You need a lower-level orchestrator with custom model runners or workspace policy. |
| `CodexModelRunnerAdapter` | You want the default real adapter backed by `@openai/codex-sdk`. |
| `MockModelRunner` | You need deterministic local tests without calling real models. |

The package also exports the core types: `TaskDAG`, `TaskContract`,
`OrchestrationEvent`, `OrchestrationStream`, `OrchestrationResult`,
`PlanReviewController`, `ThreadRunTrace`, `ModelUsageSummary`, `ReviewResult`,
`WorkspaceManager`, `MergeBroker`, and validation helpers.

## Final-Result Run

Use `runCodingTask()` when the caller can wait for the complete result.

```ts
import { runCodingTask } from "@steve-life/code-agent-sdk";

const result = await runCodingTask(
  "Implement the requested change and keep tests passing.",
  "/path/to/target-repo",
  "main",
  {
    orchestrator: {
      fullVerificationCommands: ["npm test"],
    },
  },
);

console.log(result.status);
console.log(result.summary);
console.log(result.modelUsage.totals);
```

`runCodingTask()` rejects manual plan review because a plain Promise cannot
expose an approval controller. Use `runCodingTaskStreamed()` when a user must
see or approve the plan.

## Streamed Run

Use `runCodingTaskStreamed()` for product UIs, CLIs, dashboards, job logs, and
approval gates.

```ts
import { runCodingTaskStreamed } from "@steve-life/code-agent-sdk";

const stream = await runCodingTaskStreamed(
  "Implement the requested change and keep tests passing.",
  "/path/to/target-repo",
  "main",
);

for await (const event of stream.events) {
  if (event.type === "planner.completed") {
    renderTaskDag(event.dag);
  }
  if (event.type === "task.started") {
    markTaskRunning(event.task.taskId);
  }
  if (event.type === "thread.event") {
    appendThreadEvent(event.threadRunId, event.sdkEvent);
  }
  if (event.type === "model.usage") {
    updateUsage(event.model, event.usage);
  }
}

const result = await stream.result;
```

`stream.events` is the live event channel. `stream.result` is the durable final
result to store, render, or attach to a PR/job record.

## Manual Plan Review

Manual plan review is opt-in and only available on streamed runs.

When enabled, the SDK:

1. runs the planner
2. validates the generated `TaskDAG`
3. emits `plan.review.required`
4. waits for the caller to approve, revise, or cancel
5. starts workers only after approval

```ts
const stream = await runCodingTaskStreamed(
  "Implement the requested change.",
  "/path/to/target-repo",
  "main",
  {
    orchestrator: {
      planReview: { mode: "manual" },
    },
  },
);

for await (const event of stream.events) {
  if (event.type !== "plan.review.required") {
    continue;
  }

  showPlanToUser({
    revisionIndex: event.revisionIndex,
    dag: event.dag,
    options: event.options,
  });

  const order = await waitForUserOrder();

  if (order.action === "approve") {
    stream.planReview?.approve();
  } else if (order.action === "revise") {
    stream.planReview?.revise(order.feedback);
  } else {
    stream.planReview?.cancel(order.reason);
  }
}
```

Plan-review controller semantics:

| Method | Effect |
| --- | --- |
| `approve()` | Accepts the current `TaskDAG` and starts implementation. |
| `revise(feedback)` | Sends user feedback back to the planner and waits for a new `plan.review.required` event. |
| `cancel(reason?)` | Ends the run before workers start. No implementation patch is created or applied. |

`event.options` is for the caller UI. It contains action metadata such as
`approve`, `revise`, and `cancel`, including user-facing labels/descriptions and
whether feedback is required.

## TaskDAG And Task Contracts

The planner returns a `TaskDAG`:

```ts
interface TaskDAG {
  dagId: string;
  tasks: TaskContract[];
  edges: TaskDAGEdge[];
}
```

Each `TaskContract` gives one worker a clear scope:

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
  network?: Partial<NetworkPermission>;
}
```

The orchestrator validates the DAG, enforces path scope, creates isolated task
workspaces, validates patches before merge, applies accepted patches, runs
verification, and aggregates review output.

## Event Reference

| Event | Payload purpose |
| --- | --- |
| `run.started` | Run id, requirement, target project. |
| `planner.started` | Planner model and reasoning effort. |
| `planner.completed` | Generated `TaskDAG`. |
| `planner.failed` | Planner failure before a valid DAG. |
| `plan.review.required` | Plan is waiting for caller action. |
| `plan.review.approved` | Caller approved this plan revision. |
| `plan.review.revision_requested` | Caller requested replanning with feedback. |
| `plan.review.cancelled` | Caller cancelled before implementation. |
| `task.started` | Worker, verifier, or reviewer task started. |
| `task.completed` | Task completed successfully. |
| `task.failed` | Task failed. |
| `task.validation.completed` | Pre-merge validation result for a worker patch. |
| `merge.completed` | Patch merge result. |
| `verification.completed` | Verification command group result. |
| `review.completed` | Structured review result. |
| `thread.event` | Raw Codex SDK event for a planner/worker/reviewer thread. |
| `model.usage` | Usage extracted from a completed turn. |
| `run.completed` | Final non-failed result. |
| `run.failed` | Final failed result. |

For UI integration, render `planner.completed` as the plan, task events as the
timeline, `thread.event` as the detailed live log, and `model.usage` as usage
telemetry.

## Result Shape

`OrchestrationResult` is the durable output:

| Field | Meaning |
| --- | --- |
| `status` | `pass`, `needs_changes`, `reject`, `failed`, or `cancelled`. |
| `dag` | Approved/planned `TaskDAG`. |
| `taskResults` | Worker and verifier outputs. |
| `mergeResults` | Patch validation and merge outputs. |
| `verificationResults` | Command-level verification outputs. |
| `reviewResults` | Structured reviewer reports. |
| `trace` | Replayable thread traces. |
| `modelUsage` | Usage by model plus totals. |
| `summary` | Human-readable final summary. |

## Options

```ts
const stream = await runCodingTaskStreamed(message, repo, "main", {
  projectId: "my-project",
  modelConfig: {
    plannerModel: "gpt-5.5",
    componentWorkerModel: "gpt-5.3-codex-spark",
    layoutWorkerModel: "gpt-5.4-mini",
    screenWorkerModel: "gpt-5.5",
    reviewerModel: "gpt-5.5",
  },
  orchestrator: {
    planReview: { mode: "manual" },
    fullVerificationCommands: ["npm test"],
  },
});
```

Important fields:

| Field | Meaning |
| --- | --- |
| `projectId` | Stable id for traces and reports. Defaults to the repo directory name. |
| `modelConfig` | Concrete model names used by the default Codex adapter. |
| `orchestrator.planReview` | Set `{ mode: "manual" }` to require caller approval before implementation. |
| `orchestrator.fullVerificationCommands` | Repository-level validation commands after merge. |
| `orchestrator.preMergeValidation` | Patch-level validation before merge. |
| `orchestrator.modelRunner` | Custom model runner. Defaults to `CodexModelRunnerAdapter`. |

## Thin Codex Session API

Use `runTaskSessionStreamed()` when you do not need the full planner/DAG system
and only want a streamed Codex thread boundary:

```ts
import { runTaskSessionStreamed } from "@steve-life/code-agent-sdk";

for await (const event of runTaskSessionStreamed({
  message: "Inspect this repo and summarize the build steps.",
  workingDirectory: "/path/to/repo",
  emitThreadEvents: true,
})) {
  console.log(event.type, event);
}
```

This API yields normalized `thread`, `message`, `status`, `usage`,
`thread.event`, and `error` events.

## Development

```sh
pnpm install
pnpm test
pnpm run build
```

Before publishing:

```sh
pnpm test
npm pack --dry-run
```

The package publishes only `dist` through the `files` field. The GitHub Actions
publish workflow runs tests, checks whether the current version exists on npm,
and publishes with provenance when the version is new.

## Notes

- Run against a clean target repository when possible.
- The target repo should ignore `.agent-orchestrator/`.
- Manual plan review requires streamed APIs.
- Real model execution uses `CodexModelRunnerAdapter`; deterministic tests can
  inject `MockModelRunner`.
