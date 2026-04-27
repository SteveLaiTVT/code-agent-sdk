# Code Agent SDK 中文使用文档

本文档面向想把 `@steve-life/code-agent-sdk` 集成到 CLI、Web 控制台、CI
流程、内部研发平台或自定义 Agent Runner 的开发者。

SDK 的核心目标是：把一次编码需求拆成可计划、可执行、可观察、可验证、可审计的
多 Agent 工作流，而不是只发起一次模型调用。

## 1. 适用场景

Code Agent SDK 适合这些场景：

- 你希望把用户需求先转成结构化 `TaskDAG`，再按任务边界执行。
- 你希望不同任务使用不同模型，例如 Spark 做低风险纯函数，mini 做布局，GPT-5.5
  做高风险集成。
- 你希望客户端能看到整个过程：计划、任务启动、线程事件、模型用量、合并、验证、
  review、最终结果。
- 你希望 worker 不直接改主仓库，而是在隔离 workspace 中生成 patch，再由 merge
  broker 验证后应用。
- 你希望记录每个线程的原始事件和模型 token 统计，用于回放、计费、审计或调试。

它不适合把模型当成一个普通文本补全接口来用。如果只是想发一条 prompt 并拿一次
回复，直接使用模型 SDK 会更简单。

## 2. 安装

```sh
npm install @steve-life/code-agent-sdk
```

运行环境要求：

- Node.js 18 或更新版本
- TypeScript/ESM 项目
- 目标项目必须是 Git 仓库
- 真实 Codex 运行需要准备 `@openai/codex-sdk` 所需的认证和运行环境

如果你是在本地开发 SDK 本身：

```sh
git clone https://github.com/SteveLaiTVT/code-agent-sdk.git
cd code-agent-sdk
npm install
npm test
```

## 3. 最小调用

如果你只关心最终结果，用 `runCodingTask()`。

```ts
import { runCodingTask } from "@steve-life/code-agent-sdk";

const result = await runCodingTask(
  "实现一个可玩的贪吃蛇游戏，把核心游戏逻辑拆成小函数。",
  "/path/to/target-repo",
  "main",
);

console.log(result.status);
console.log(result.summary);
console.log(result.modelUsage.totals);
```

参数含义：

| 参数 | 说明 |
| --- | --- |
| `message` | 用户的编码需求。 |
| `repo` | 目标仓库的本地绝对路径或相对路径。 |
| `branch` | 运行前要 checkout 的分支。 |
| `options` | 可选配置，包括项目 ID、模型配置、编排器配置。 |

`runCodingTask()` 会做这些事：

1. 检查 `repo` 是否是 Git 仓库。
2. 尝试 fetch `origin/<branch>`。
3. checkout 到传入的 `branch`。
4. 创建 `ProjectSpace`。
5. 使用真实 `CodexModelRunnerAdapter` 执行编排。
6. 返回 `OrchestrationResult`。

建议在目标仓库工作区干净时运行，因为成功验证后的 patch 可能会被应用到目标仓库。

## 4. 流式调用

如果你要做 Web 控制台、CLI 进度条、任务日志、设备面板或可视化时间线，应该使用
`runCodingTaskStreamed()`。

```ts
import { runCodingTaskStreamed } from "@steve-life/code-agent-sdk";

const stream = await runCodingTaskStreamed(
  "给设置页做组件拆分，并补充加载、空状态和错误状态。",
  "/path/to/target-repo",
  "main",
);

for await (const event of stream.events) {
  switch (event.type) {
    case "run.started":
      console.log("开始运行", event.runId);
      break;
    case "planner.completed":
      console.log("计划任务数", event.dag.tasks.length);
      break;
    case "task.started":
      console.log("任务开始", event.task.taskId, event.workerId);
      break;
    case "thread.event":
      console.log("线程事件", event.threadRunId, event.model, event.sdkEvent.type);
      break;
    case "model.usage":
      console.log("模型用量", event.model, event.usage);
      break;
    case "run.completed":
    case "run.failed":
      console.log("最终状态", event.result.status, event.result.summary);
      break;
  }
}

const result = await stream.result;
console.log(result.trace);
console.log(result.modelUsage.byModel);
```

`stream.events` 是异步迭代器，适合边运行边渲染。`stream.result` 是最终结果的
Promise，适合在任务结束后落库、生成报告或更新 PR 评论。

### Plan 审核模式

Plan 审核是显式开启的模式。开启后，orchestrator 会先让 planner 生成并校验
`TaskDAG`，然后发出 `plan.review.required`，在调用端放行之前不会启动 worker、
merge、verification 或 review。

```ts
const stream = await runCodingTaskStreamed(
  "重构设置页。",
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

`stream.planReview` 提供 `approve()`、`revise(feedback)` 和 `cancel(reason)`。
`revise()` 会把反馈交回 planner 重新生成 DAG，并再次进入审核；`cancel()` 会以
`status: "cancelled"` 结束 run，不创建任务工作区、不应用 patch。manual 模式不能用
非流式 API，因为普通 Promise 没有 controller。

### Pre-Merge Validation

实现任务的 patch 会先在临时 validation workspace 里验证，验证通过后才 merge 到目标
项目。SDK 不假设项目一定是 Node，也不假设是 Android、iOS、Flutter 或 Web。planner
需要在每个 task 上设置 `validationTools` 和 `verificationCommands`，SDK 只负责在
validation workspace 里执行这些 task-level 命令。调用端也可以加更严格的全局命令：

```ts
const stream = await runCodingTaskStreamed(message, repo, "main", {
  orchestrator: {
    preMergeValidation: {
      commands: ["npm run build"],
    },
  },
});
```

如果 pre-merge validation 失败，当前 task 会失败，patch 不会进入目标项目。事件流会发出
`task.validation.completed`，里面带具体命令结果。

## 5. 事件类型

流式 API 会发出这些事件：

| 事件 | 说明 |
| --- | --- |
| `run.started` | 一次编排运行开始。 |
| `planner.started` | planner 线程即将运行。 |
| `planner.completed` | planner 生成了 `TaskDAG`。 |
| `planner.failed` | planner 失败，未生成可用 DAG。 |
| `task.started` | worker、verifier 或 reviewer 任务开始。 |
| `task.completed` | 任务成功完成。 |
| `task.failed` | 任务失败。 |
| `merge.completed` | merge broker 完成 patch 校验和应用。 |
| `verification.completed` | 一组验证命令执行完成。 |
| `review.completed` | reviewer 生成结构化报告。 |
| `thread.event` | 底层 Codex SDK 的原始线程事件。 |
| `model.usage` | 从完成的 turn 中提取出的模型用量。 |
| `run.completed` | 运行以非 failed 结果结束。 |
| `run.failed` | 运行以 failed 状态结束。 |

前端界面通常可以这样分层展示：

- 用 `planner.completed` 画任务图。
- 用 `task.started`、`task.completed`、`task.failed` 更新任务状态。
- 用 `thread.event` 展示每个线程的详细过程。
- 用 `model.usage` 和最终 `result.modelUsage` 展示模型用量统计。
- 用 `verification.completed` 和 `review.completed` 展示质量门禁。

## 6. 结果对象

`OrchestrationResult` 是一次运行最终可以保存下来的结构化结果。

| 字段 | 说明 |
| --- | --- |
| `status` | 最终状态：`pass`、`needs_changes`、`reject`、`failed`。 |
| `dag` | planner 生成的任务图。 |
| `taskResults` | worker 和 verifier 的执行结果。 |
| `mergeResults` | patch 校验和合并结果。 |
| `verificationResults` | 验证命令结果。 |
| `reviewResults` | review 结构化报告。 |
| `trace` | 按线程聚合的可回放事件轨迹。 |
| `modelUsage` | 按模型聚合的 token 和 turn 统计。 |
| `summary` | 人类可读的运行总结。 |

`modelUsage` 同时提供按模型统计和总计：

```ts
console.log(result.modelUsage.byModel["gpt-5.5"]);
console.log(result.modelUsage.totals.inputTokens);
console.log(result.modelUsage.totals.outputTokens);
```

如果你的产品要做审计、成本统计、过程回放或问题定位，建议保存 `trace` 和
`modelUsage`。

## 7. TaskDAG 和任务契约

planner 的输出是 `TaskDAG`。

```ts
interface TaskDAG {
  dagId: string;
  tasks: TaskContract[];
  edges: TaskDAGEdge[];
}
```

每个 `TaskContract` 都描述一个可执行单元。

```ts
interface TaskContract {
  taskId: string;
  title: string;
  role: AgentRole;
  model: string;
  objective: string;
  readPaths: string[];
  writePaths: string[];
  forbiddenPaths: string[];
  dependencies: string[];
  acceptanceCriteria: string[];
  validationTools?: string[];
  verificationCommands: string[];
  riskLevel: "low" | "medium" | "high" | "critical";
}
```

关键字段：

| 字段 | 说明 |
| --- | --- |
| `role` | 决定这个任务由 planner、component worker、layout worker、screen worker、verifier、reviewer 或 merge broker 负责。 |
| `model` | planner 为该任务选择的具体模型。 |
| `readPaths` | worker 可以阅读的路径。 |
| `writePaths` | worker 被允许修改的路径。 |
| `forbiddenPaths` | 明确禁止访问或修改的路径。 |
| `dependencies` | 当前任务依赖的上游任务。 |
| `acceptanceCriteria` | 完成标准。 |
| `validationTools` | planner 选择的验证工具，例如 `gradle`、`xcodebuild`、`flutter`、`npm` 或项目脚本。 |
| `verificationCommands` | 该任务相关的验证命令。 |
| `riskLevel` | 风险等级，用于调度和 review 策略。 |

编排器会校验 DAG、检查路径范围、按依赖顺序运行任务，并避免把有写路径冲突的任务放
进同一个并行批次。

## 8. 模型路由

SDK 的默认分工如下：

| 角色 | 默认模型层级 | 适合任务 |
| --- | --- | --- |
| `planner` | GPT-5.5 xhigh | 理解需求、拆任务、决定模型、制定验证和 review 计划。 |
| `component-worker` | Spark | 纯函数、纯组件、validator、formatter、mapper、小类型。 |
| `layout-worker` | mini | 卡片、网格、弹窗、drawer、加载态、空状态、错误状态等布局组合。 |
| `screen-worker` | GPT-5.5 high/medium | 页面逻辑、状态协调、路由、权限、数据加载、跨模块集成。 |
| `verifier` | program | lint、typecheck、test、build、smoke check。 |
| `reviewer` | GPT-5.5 high/xhigh | 合同、集成、架构、安全 review。 |
| `merge-broker` | program | 校验并应用 patch。 |

planner 会在每个任务上写入 `task.model`。最终 `result.modelUsage` 会按实际线程事件
统计每个模型的使用情况。

## 9. 自定义模型配置

```ts
import { runCodingTask } from "@steve-life/code-agent-sdk";

const result = await runCodingTask(
  "重构设置页，并把数据加载逻辑和展示组件分开。",
  "/path/to/target-repo",
  "main",
  {
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

常用配置：

| 配置 | 说明 |
| --- | --- |
| `projectId` | 项目 ID，不传时默认使用仓库目录名。 |
| `modelConfig.plannerModel` | planner 使用的模型。 |
| `modelConfig.componentWorkerModel` | component worker 默认模型。 |
| `modelConfig.layoutWorkerModel` | layout worker 默认模型。 |
| `modelConfig.screenWorkerModel` | screen worker 默认模型。 |
| `modelConfig.reviewerModel` | reviewer 默认模型。 |
| `orchestrator.maxSparkWorkers` | Spark worker 最大并发。 |
| `orchestrator.maxMiniWorkers` | mini worker 最大并发。 |
| `orchestrator.maxGpt55Workers` | GPT-5.5 worker 最大并发。 |
| `orchestrator.fullVerificationCommands` | 全量验证命令。 |

## 10. Mock Runner

如果你只是要测试调用链、前端进度展示、结果落库或报告生成，可以使用
`MockModelRunner`，不调用真实模型。

```ts
import {
  AgentOrchestrator,
  MockModelRunner,
  type ProjectSpace,
} from "@steve-life/code-agent-sdk";

const project: ProjectSpace = {
  projectId: "local-demo",
  root: process.cwd(),
};

const orchestrator = new AgentOrchestrator({
  modelRunner: new MockModelRunner(),
  executeVerificationCommands: false,
});

const result = await orchestrator.run(
  "实现一个任务卡片系统。",
  project,
);
```

Mock 模式会返回固定的任务卡片 DAG、确定性的 worker 结果和结构化 review 报告。它适合
写单元测试和调试 UI，不适合验证真实代码生成质量。

## 11. 工作区和合并流程

实现类 worker 不直接修改主项目根目录。默认真实运行路径会使用：

- `WorkspaceManager({ strategy: "git-worktree", keepWorkspaces: true })`
- `MergeBroker`
- `CodexModelRunnerAdapter`
- `executeVerificationCommands: true`

流程如下：

1. 为任务创建隔离 workspace。
2. worker 在 workspace 中执行。
3. 从 workspace 生成 patch。
4. 根据 `TaskContract.writePaths` 校验 patch 改动范围。
5. 校验通过后把 patch 应用到目标项目。
6. 执行任务级和全量验证命令。
7. 执行 reviewer 并聚合 review 结果。

workspace 默认位于 `.agent-orchestrator/` 下。目标仓库应该忽略这个目录，除非你希望
保留它用于排查问题。

## 12. 权限模型

权限来自三个维度：

```txt
AgentRole + ProjectSpace + TaskScope
```

这里没有 `projectType` 开关。所有路径都必须落在 `ProjectSpace.root` 内，并且每个任务
只能读写自己合同中允许的路径。

网络权限分为四类：

| 权限 | 说明 |
| --- | --- |
| `shellNetwork` | 命令级网络访问，例如 `curl`、`npm install`、`git clone`、`wget`。 |
| `webSearch` | 受控网页搜索或文档检索。 |
| `mcpRead` | 只读 MCP 访问，例如读取 GitHub、Slack、Jira 或文档。 |
| `mcpWrite` | 有副作用的 MCP 访问，例如创建 PR、更新 issue、发送消息。 |

只有 `shellNetwork` 会映射到 Codex sandbox 的网络访问。`webSearch`、`mcpRead` 和
`mcpWrite` 属于编排层的工具权限。

## 13. 本地 Demo

```sh
npm run agent:demo
```

Demo 会：

1. 用当前项目创建 `ProjectSpace`。
2. 让 mock planner 生成任务卡片系统的 `TaskDAG`。
3. 并行运行 Spark component 任务。
4. 生成 mock patch。
5. 通过 `MergeBroker` 校验路径。
6. 运行 mock verification。
7. 聚合合同、集成、架构、安全 review 报告。

## 14. 开发和发布检查

SDK 本身开发时常用命令：

```sh
npm install
npm test
npm run agent:demo
```

发布前检查：

```sh
npm run build
npm pack --dry-run
```

## 15. 常见问题

### 目标目录不是 Git 仓库

`runCodingTask()` 会先检查目标目录是否是 Git 仓库。如果不是，会抛出
`Not a git repository`。

### checkout 分支失败

SDK 会尝试 fetch `origin/<branch>`，然后 checkout 到传入分支。如果本地有冲突、
分支不存在或工作区状态不允许切换，checkout 会失败。建议先手动确认目标仓库分支和
工作区状态。

### 为什么没有真实模型事件

如果你使用 `MockModelRunner`，事件是 mock 出来的。如果要看到真实 Codex SDK 的线程
事件，需要走 `CodexModelRunnerAdapter`，也就是使用默认的 `runCodingTask()` 或
`runCodingTaskStreamed()` 路径。

### 为什么任务没有并行

编排器只会并行运行已满足依赖、角色并发未超过限制、且写路径不冲突的任务。如果任务
之间有依赖或写入同一范围，会被顺序执行。

### 验证失败后还会 review 吗

如果验证结果中存在 failed，当前编排会在 review 前返回 failed，避免在明显未通过的
代码上继续执行 review。

### 是否会访问网络

真实 worker 默认 `networkAccessEnabled: false`。任务级网络权限和工具权限需要通过
编排层显式建模，不能假设 worker 可以随意联网。

## 16. 集成建议

CLI 集成：

- 使用 `runCodingTaskStreamed()`。
- 把 `task.started`、`task.completed`、`task.failed` 渲染成进度。
- 结束后打印 `result.summary` 和失败原因。

Web 控制台集成：

- 用 `planner.completed` 渲染任务图。
- 用 `thread.event` 渲染每个线程的详细日志。
- 用 `model.usage` 渲染实时模型用量。
- 保存 `result.trace` 方便用户回放。

CI 集成：

- 使用固定 `fullVerificationCommands`。
- 将 `result.status !== "pass"` 视为失败门禁。
- 把 `verificationResults` 和 `reviewResults` 写入构建产物。

内部研发平台集成：

- 将 `ProjectSpace`、`TaskDAG`、`trace`、`modelUsage` 全部持久化。
- 对高风险任务降低并发或指定更强模型。
- 在 UI 中明确展示 mock 运行和真实模型运行的区别。

## 17. 安全使用清单

运行真实任务前建议确认：

- 目标仓库是正确的。
- 分支是正确的。
- 工作区已提交或已备份。
- `.agent-orchestrator/` 已被忽略。
- 验证命令可以在本机运行。
- 模型配置符合你的成本和风险预期。
- UI 或日志中能看到失败任务、验证失败和 review 结果。

## 18. 下一步

建议先用 `MockModelRunner` 打通调用链和 UI，再切到默认的真实
`CodexModelRunnerAdapter`。如果你的系统已有自己的模型网关，也可以实现
`ModelRunner` 接口，把 planner、worker、reviewer 接到内部模型路由层。
