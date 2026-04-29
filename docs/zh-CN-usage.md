# Code Agent SDK 中文使用文档

`@steve-life/code-agent-sdk` 是一个 TypeScript SDK，用来把编码需求拆成
plan、worker、patch、验证、review 和可回放 trace。它应该被 CLI、Web 控制台、
CI、内部研发平台或 Agent Runtime 集成，而不是作为示例项目运行。

本仓库不再保留本地 demo 项目。SDK 本体只保留正式接口、类型、编排器、适配器和测试。

## 安装

```sh
npm install @steve-life/code-agent-sdk
```

运行要求：

- Node.js 18 或更新版本
- ESM 运行环境
- 目标项目必须是 Git 仓库
- 真实 Codex 运行需要配置 OpenAI/Codex 凭证

SDK 会通过 `createCodexClientOptions()` 读取本地 `.env`。API Key 支持
`OPENAI_API_KEY` 和 `OPENAI_KEY`；Base URL 支持 `OPENAI_API_BSSE_URL`、
`OPENAI_API_BASE_URL`、`OPENAI_BASE_URL` 和 `OPENAI_URL`。

## 核心接口

| 接口 | 使用场景 |
| --- | --- |
| `runCodingTask(message, repo, branch, options?)` | 只需要最终 `OrchestrationResult`。 |
| `runCodingTaskStreamed(message, repo, branch, options?)` | 需要实时事件、线程日志、模型用量或人工审核 plan。 |
| `runTaskSessionStreamed(input, options?)` | 只需要一个轻量的 Codex thread/session 流式封装。 |
| `runCodeAgentStreamed(input)` | 需要编排结果之外再派生报告、测试计划等 Code-Agent artifact。 |
| `AgentOrchestrator` | 需要自定义 model runner、workspace 或合并策略。 |
| `CodexModelRunnerAdapter` | 默认真实模型适配器，底层使用 `@openai/codex-sdk`。 |
| `MockModelRunner` | 测试用的确定性 runner，不调用真实模型。 |

常用导出类型包括：`TaskDAG`、`TaskContract`、`OrchestrationEvent`、
`OrchestrationStream`、`OrchestrationResult`、`PlanReviewController`、
`ThreadRunTrace`、`ModelUsageSummary`、`ReviewResult`、`WorkspaceManager` 和
`MergeBroker`。

## 只取最终结果

当调用端可以等待完整运行结束时，使用 `runCodingTask()`：

```ts
import { runCodingTask } from "@steve-life/code-agent-sdk";

const result = await runCodingTask(
  "实现这个需求，并保持测试通过。",
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

注意：`runCodingTask()` 不能开启 manual plan review，因为普通 Promise 暴露不了
approve/revise/cancel controller。需要用户审核 plan 时必须使用
`runCodingTaskStreamed()`。

## 流式运行

Web 控制台、CLI 进度条、任务日志和审批流应该使用 `runCodingTaskStreamed()`：

```ts
import { runCodingTaskStreamed } from "@steve-life/code-agent-sdk";

const stream = await runCodingTaskStreamed(
  "实现这个需求，并保持测试通过。",
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

`stream.events` 用来实时渲染过程；`stream.result` 是最终可落库、可展示、可写入 PR
评论的结构化结果。

## Plan 审核

Plan 审核是显式开启的 streamed-only 能力：

1. planner 先生成 `TaskDAG`
2. SDK 校验 DAG 和路径范围
3. 发出 `plan.review.required`
4. 调用端展示 plan，并等待用户选择
5. 用户批准后才开始 worker、merge、verification 和 review

```ts
const stream = await runCodingTaskStreamed(
  "实现这个需求。",
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

Controller 语义：

| 方法 | 作用 |
| --- | --- |
| `approve()` | 批准当前 `TaskDAG`，开始执行实现任务。 |
| `revise(feedback)` | 把用户反馈交回 planner，等待新的 `plan.review.required`。 |
| `cancel(reason?)` | 在实现前结束运行，不创建、不应用 worker patch。 |

`event.options` 用于 UI 展示，包含 `approve`、`revise`、`cancel` 等动作的 label、
description 和是否需要反馈文本。

## TaskDAG 和任务契约

planner 输出 `TaskDAG`：

```ts
interface TaskDAG {
  dagId: string;
  tasks: TaskContract[];
  edges: TaskDAGEdge[];
}
```

每个 `TaskContract` 是 worker 的清晰边界：

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

编排器会校验 DAG、检查路径、创建隔离 workspace、在 merge 前验证 patch、应用通过的
patch、执行验证命令，并聚合 review 输出。

## 事件表

| 事件 | 说明 |
| --- | --- |
| `run.started` | 一次运行开始，包含 run id、需求和目标项目。 |
| `planner.started` | planner 线程开始。 |
| `planner.completed` | planner 生成了 `TaskDAG`。 |
| `planner.failed` | planner 未生成有效 DAG。 |
| `plan.review.required` | 等待调用端审核 plan。 |
| `plan.review.approved` | 调用端批准当前 plan。 |
| `plan.review.revision_requested` | 调用端要求带反馈重新规划。 |
| `plan.review.cancelled` | 调用端在实现前取消。 |
| `task.started` | worker、verifier 或 reviewer 任务开始。 |
| `task.completed` | 任务成功完成。 |
| `task.failed` | 任务失败。 |
| `task.validation.completed` | worker patch 的 pre-merge validation 完成。 |
| `merge.completed` | patch merge 完成。 |
| `verification.completed` | 一组验证命令完成。 |
| `review.completed` | reviewer 生成结构化报告。 |
| `thread.event` | planner/worker/reviewer 的原始 Codex SDK 线程事件。 |
| `model.usage` | 从完成 turn 中提取的模型用量。 |
| `run.completed` | 最终非 failed 结果。 |
| `run.failed` | 最终 failed 结果。 |

建议 UI 用 `planner.completed` 展示计划，用 task 事件展示时间线，用
`thread.event` 展示详细日志，用 `model.usage` 展示实时用量。

## 结果对象

`OrchestrationResult` 是最终可持久化对象：

| 字段 | 说明 |
| --- | --- |
| `status` | `pass`、`needs_changes`、`reject`、`failed` 或 `cancelled`。 |
| `dag` | planner/用户批准后的任务图。 |
| `taskResults` | worker 和 verifier 输出。 |
| `mergeResults` | patch 校验和合并输出。 |
| `verificationResults` | 命令级验证输出。 |
| `reviewResults` | 结构化 review 报告。 |
| `trace` | 可回放线程轨迹。 |
| `modelUsage` | 按模型聚合的用量和总计。 |
| `summary` | 最终运行总结。 |

## 常用配置

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

| 字段 | 说明 |
| --- | --- |
| `projectId` | trace 和报告中的稳定项目 ID，默认使用 repo 目录名。 |
| `modelConfig` | 默认 Codex adapter 使用的具体模型。 |
| `orchestrator.planReview` | 设置 `{ mode: "manual" }` 后必须由用户批准 plan。 |
| `orchestrator.fullVerificationCommands` | merge 后的仓库级验证命令。 |
| `orchestrator.preMergeValidation` | merge 前的 patch 级验证配置。 |
| `orchestrator.modelRunner` | 自定义模型 runner，默认是 `CodexModelRunnerAdapter`。 |

## 轻量 Codex Session

如果不需要 planner/DAG，只需要一个流式 Codex thread，可以用
`runTaskSessionStreamed()`：

```ts
import { runTaskSessionStreamed } from "@steve-life/code-agent-sdk";

for await (const event of runTaskSessionStreamed({
  message: "检查这个仓库并总结构建步骤。",
  workingDirectory: "/path/to/repo",
  emitThreadEvents: true,
})) {
  console.log(event.type, event);
}
```

该接口会输出规范化的 `thread`、`message`、`status`、`usage`、`thread.event` 和
`error` 事件。

## 开发和发布检查

```sh
pnpm install
pnpm test
pnpm run build
```

发布前：

```sh
pnpm test
npm pack --dry-run
```

包通过 `files: ["dist"]` 只发布构建产物。GitHub Actions 发布流程会安装依赖、运行
测试、检查当前版本是否已经存在于 npm，然后在版本未发布时使用 provenance 发布。

## 注意事项

- 尽量在干净的目标仓库上运行。
- 目标仓库应忽略 `.agent-orchestrator/`。
- Manual plan review 只能使用 streamed API。
- 真实模型执行走 `CodexModelRunnerAdapter`；测试可以注入 `MockModelRunner`。
