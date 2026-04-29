import type {
  ModelRunner,
  ModelRunnerPlannerContext,
  ModelRunnerReviewerInput,
  ModelRunnerWorkerInput,
  ModelRunnerWorkerOutput,
} from "../agents/model-runner.js";
import {
  Codex,
  type CodexOptions,
  type Input,
  type RunResult,
  type ThreadEvent,
  type ThreadItem,
  type ThreadOptions,
  type TurnOptions,
  type Usage,
} from "@openai/codex-sdk";
import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { emitThreadEvent } from "../core/orchestration-stream.js";
import { createCodexClientOptions } from "../common/codex-env.js";
import { createCodexOptions, type OrchestrationCodexOptions } from "../agents/codex-options.js";
import { taskContractToScope } from "../core/task-contract.js";
import type {
  AgentRole,
  ModelRunTelemetry,
  PlanRevisionContext,
  TaskContract,
  TaskDAG,
} from "../core/types.js";
import type { ReviewResult, ReviewType } from "../review/review-types.js";

const execFileAsync = promisify(execFile);

export interface CodexModelRunnerAdapterConfig {
  plannerModel: string;
  componentWorkerModel: string;
  layoutWorkerModel: string;
  screenWorkerModel: string;
  reviewerModel: string;
  verifierModel?: string;
}

export type CodexThreadDriver = {
  runStreamed(input: Input, turnOptions?: TurnOptions): Promise<{ events: AsyncIterable<ThreadEvent> }>;
};

export type CodexClientDriver = {
  startThread(options?: ThreadOptions): CodexThreadDriver;
};

export interface CodexModelRunnerAdapterRuntimeOptions {
  codex?: CodexClientDriver;
  createCodex?: (options: CodexOptions) => CodexClientDriver;
  clientOptions?: CodexOptions;
}

export const defaultCodexModelRunnerAdapterConfig: CodexModelRunnerAdapterConfig = {
  plannerModel: "gpt-5.5",
  componentWorkerModel: "gpt-5.3-codex-spark",
  layoutWorkerModel: "gpt-5.4-mini",
  screenWorkerModel: "gpt-5.5",
  reviewerModel: "gpt-5.5",
};

export class CodexModelRunnerAdapter implements ModelRunner {
  readonly config: CodexModelRunnerAdapterConfig;
  private readonly codex?: CodexClientDriver;
  private readonly createCodex: (options: CodexOptions) => CodexClientDriver;
  private readonly clientOptions: CodexOptions;

  constructor(
    config: Partial<CodexModelRunnerAdapterConfig> = {},
    runtime: CodexClientDriver | CodexModelRunnerAdapterRuntimeOptions = {}
  ) {
    this.config = {
      ...defaultCodexModelRunnerAdapterConfig,
      ...config,
    };
    const runtimeOptions = isCodexClientDriver(runtime) ? { codex: runtime } : runtime;
    this.codex = runtimeOptions.codex;
    this.createCodex = runtimeOptions.createCodex ?? ((options) => new Codex(options));
    this.clientOptions = runtimeOptions.clientOptions ?? createCodexClientOptions();
  }

  async runPlanner(requirement: string, context: ModelRunnerPlannerContext = {}): Promise<TaskDAG> {
    const project = context.project;
    if (!project) {
      throw new Error("Codex planner requires ProjectSpace context.");
    }

    const codexOptions =
      context.codexOptions ??
      createCodexOptions({
        role: "planner",
        project,
      });
    const thread = this.startThread(codexOptions, {
      model: this.config.plannerModel,
      modelReasoningEffort: "xhigh",
      workingDirectory: project.root,
    });

    const result = await runThreadStreamed(
      thread,
      createPlannerPrompt(requirement, context.planRevision),
      {
        outputSchema: taskDagSchema,
      },
      context.telemetry
    );
    return parseJsonResponse<TaskDAG>(result.finalResponse, "planner TaskDAG");
  }

  async runWorker(input: ModelRunnerWorkerInput): Promise<ModelRunnerWorkerOutput> {
    const model = input.task.model || this.modelForRole(input.task.role);
    const codexOptions =
      input.codexOptions ??
      createCodexOptions({
        role: input.task.role,
        project: { projectId: input.task.taskId, root: input.workspacePath },
        taskScope: taskContractToScope(input.task),
      });
    const thread = this.startThread(codexOptions, {
      model,
      modelReasoningEffort: reasoningForTask(input.task),
      workingDirectory: input.workspacePath,
    });

    const result = await runThreadStreamed(
      thread,
      createWorkerPrompt(input.task, model),
      undefined,
      input.telemetry
    );
    const patchPath = await createGitPatch(input.workspacePath, input.task.taskId);
    const changedFiles = await getChangedFiles(input.workspacePath);

    return {
      summary: result.finalResponse,
      changedFiles,
      patchPath,
      logs: resultToLogs(result),
    };
  }

  async runReviewer(input: ModelRunnerReviewerInput): Promise<ReviewResult> {
    if (!input.workspacePath) {
      throw new Error("Codex reviewer requires a review workspacePath.");
    }

    const model = input.task.model || this.config.reviewerModel;
    const codexOptions =
      input.codexOptions ??
      createCodexOptions({
        role: "reviewer",
        project: { projectId: input.task.taskId, root: input.workspacePath },
        taskScope: {
          readablePaths: input.task.readPaths,
          reportPaths: [".agent-orchestrator/reviews", ".agent-orchestrator/tmp"],
          forbiddenPaths: input.task.forbiddenPaths,
        },
      });
    const thread = this.startThread(codexOptions, {
      model,
      modelReasoningEffort: input.reviewType === "security" ? "xhigh" : "high",
      workingDirectory: input.workspacePath,
    });

    const result = await runThreadStreamed(
      thread,
      createReviewerPrompt(input.task, input.reviewType),
      {
        outputSchema: reviewResultSchema,
      },
      input.telemetry
    );
    return parseJsonResponse<ReviewResult>(result.finalResponse, `${input.reviewType} ReviewResult`);
  }

  private modelForRole(role: AgentRole): string {
    switch (role) {
      case "component-worker":
        return this.config.componentWorkerModel;
      case "layout-worker":
        return this.config.layoutWorkerModel;
      case "screen-worker":
        return this.config.screenWorkerModel;
      case "reviewer":
        return this.config.reviewerModel;
      case "planner":
        return this.config.plannerModel;
      case "verifier":
      case "merge-broker":
        return this.config.verifierModel ?? this.config.screenWorkerModel;
    }
  }

  private startThread(
    codexOptions: OrchestrationCodexOptions,
    threadOptions: ThreadOptions
  ): CodexThreadDriver {
    const codex = this.codex ?? this.createCodex(mergeCodexOptions(this.clientOptions, codexOptions));
    return codex.startThread({
      ...threadOptions,
      sandboxMode: codexOptions.config.sandbox_mode,
      approvalPolicy: codexOptions.config.approval_policy,
      networkAccessEnabled: codexOptions.config.sandbox_workspace_write.network_access,
      webSearchEnabled: codexOptions.toolPermissions.webSearch,
    });
  }
}

async function runThreadStreamed(
  thread: CodexThreadDriver,
  input: Input,
  turnOptions: TurnOptions | undefined,
  telemetry: ModelRunTelemetry | undefined
): Promise<RunResult> {
  const streamed = await thread.runStreamed(input, turnOptions);
  const itemsById = new Map<string, ThreadItem>();
  let usage: Usage | null = null;

  for await (const event of streamed.events) {
    emitThreadEvent(telemetry, event);

    if (
      event.type === "item.started" ||
      event.type === "item.updated" ||
      event.type === "item.completed"
    ) {
      itemsById.set(event.item.id, event.item);
    }
    if (event.type === "turn.completed") {
      usage = event.usage;
    }
    if (event.type === "turn.failed") {
      throw new Error(`Codex turn failed: ${event.error.message}`);
    }
    if (event.type === "error") {
      throw new Error(`Codex stream failed: ${event.message}`);
    }
  }

  const items = [...itemsById.values()];
  let finalResponse = "";
  for (const item of items) {
    if (item.type === "agent_message") {
      finalResponse = item.text;
    }
  }
  return {
    items,
    finalResponse,
    usage,
  };
}

function isCodexClientDriver(value: unknown): value is CodexClientDriver {
  return Boolean(value && typeof value === "object" && "startThread" in value);
}

function mergeCodexOptions(
  baseOptions: CodexOptions,
  orchestrationOptions: OrchestrationCodexOptions
): CodexOptions {
  return {
    ...baseOptions,
    config: {
      ...(baseOptions.config ?? {}),
      ...orchestrationOptions.config,
    } as CodexOptions["config"],
  };
}

function reasoningForRole(role: AgentRole): ThreadOptions["modelReasoningEffort"] {
  switch (role) {
    case "component-worker":
      return "low";
    case "layout-worker":
      return "medium";
    case "screen-worker":
      return "high";
    case "reviewer":
      return "high";
    case "planner":
      return "xhigh";
    case "verifier":
    case "merge-broker":
      return "medium";
  }
}

function reasoningForTask(task: TaskContract): ThreadOptions["modelReasoningEffort"] {
  if (task.reasoningEffort === "none") {
    return "minimal";
  }
  return task.reasoningEffort ?? reasoningForRole(task.role);
}

function createPlannerPrompt(
  requirement: string,
  planRevision?: PlanRevisionContext
): string {
  const lines = [
    "You are the planner agent in a multi-model coding orchestration system.",
    "Read the repository and split the user's coding requirement into a TaskDAG.",
    "",
    "Hard rules:",
    "- Use component-worker tasks for small pure functions, pure components, validators, formatters, mappers, and tiny types.",
    "- component-worker tasks must be small and must not share writePaths with parallel component-worker tasks.",
    "- Use layout-worker tasks for presentational layout composition.",
    "- Use screen-worker tasks for state, orchestration, app wiring, routing, lifecycle, and complex integration.",
    "- If component-worker tasks exist, every layout-worker task must directly or indirectly depend on the related component-worker tasks.",
    "- If layout-worker tasks exist, every screen-worker task must directly or indirectly depend on a layout-worker task. Use component-worker or verifier roles for unrelated backend/data-only work instead of screen-worker.",
    "- For every task, set model to the exact model string that should run that task.",
    "- Prefer gpt-5.3-codex-spark for tiny pure component-worker tasks, gpt-5.4-mini for layout-worker tasks, and gpt-5.5 for planner/reviewer/high-risk integration tasks.",
    "- For every task, set validationTools to the project-specific validation tools that should be used, such as npm, pnpm, yarn, gradle, xcodebuild, flutter, dart, pytest, cargo, go, or custom scripts. Use an empty array only when no validation applies.",
    "- Put project-specific syntax, typecheck, compile, lint, or focused test commands in each implementation task's verificationCommands so patches can be validated before merge.",
    "- Do not assume Node.js. Choose validation tools and commands from the repository's actual platform and scripts.",
    "- If the user names global verification commands, include the relevant command on implementation tasks as well as verifier tasks when it can run against a single patch.",
    "- Add verifier and reviewer tasks after implementation tasks.",
    "- Reviewer tasks must depend on every implementation task.",
    "- Do not include projectType.",
    "- Use relative paths only.",
    "- Never use parent traversal paths such as .., ../*, or absolute paths in readPaths, writePaths, or forbiddenPaths.",
    "- Always include model, reasoningEffort, expectedOutputs, and notes. Use empty arrays for no outputs/notes.",
    "- Always include network. Set every network flag to false unless a task explicitly needs that access.",
    "- Avoid package.json/global config changes unless absolutely necessary.",
    "- Keep forbiddenPaths populated with .env, .git, node_modules, dist, build, .next, coverage.",
    "",
    `Requirement:\n${requirement}`,
  ];

  if (planRevision) {
    lines.push(
      "",
      `Plan revision index: ${planRevision.revisionIndex}`,
      "",
      "The previous TaskDAG was reviewed by the caller and needs revision.",
      "Keep the original requirement, but incorporate the caller feedback below.",
      "",
      "Caller feedback:",
      planRevision.feedback,
      "",
      "Previous TaskDAG:",
      JSON.stringify(planRevision.previousDag, null, 2)
    );
  }

  return lines.join("\n");
}

function createWorkerPrompt(task: TaskContract, model: string): string {
  return [
    `You are running as ${task.role} using model ${model}.`,
    "Implement only the assigned TaskContract.",
    "",
    "TaskContract:",
    JSON.stringify(task, null, 2),
    "",
    "Hard rules:",
    "- Edit only files inside writePaths.",
    "- Do not edit forbiddenPaths.",
    "- If role is component-worker, keep work limited to pure functions, pure components, tiny validators/formatters/mappers/types.",
    "- If role is layout-worker, do not own screen-level data loading or complex orchestration.",
    "- If role is screen-worker, wire the screen/application behavior using existing lower-level pieces.",
    "- Run the task verification commands when practical.",
    "- Leave a concise final summary with files changed and verification.",
  ].join("\n");
}

function createReviewerPrompt(task: TaskContract, reviewType: ReviewType): string {
  return [
    `You are a read-only ${reviewType} reviewer.`,
    "Do not modify source files. You may inspect files and run verification commands.",
    "Return only a structured ReviewResult matching the provided schema.",
    "For issue.file, use an empty string when the issue is not tied to a single file.",
    "",
    "Review task:",
    JSON.stringify(task, null, 2),
  ].join("\n");
}

async function createGitPatch(workspacePath: string, taskId: string): Promise<string> {
  const patchDir = path.join(workspacePath, ".agent-orchestrator", "patches");
  await mkdir(patchDir, { recursive: true });
  await execFileAsync("git", ["-C", workspacePath, "add", "-N", "."], { encoding: "utf8" }).catch(
    () => undefined
  );
  const { stdout } = await execFileAsync("git", ["-C", workspacePath, "diff", "--binary", "HEAD"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 20,
  });
  const patchPath = path.join(patchDir, `${taskId}.patch`);
  await writeFile(patchPath, stdout, "utf8");
  return patchPath;
}

async function getChangedFiles(workspacePath: string): Promise<string[]> {
  await execFileAsync("git", ["-C", workspacePath, "add", "-N", "."], { encoding: "utf8" }).catch(
    () => undefined
  );
  const { stdout } = await execFileAsync("git", ["-C", workspacePath, "diff", "--name-only", "HEAD"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((filePath) => !filePath.startsWith(".agent-orchestrator/"));
}

function resultToLogs(result: RunResult): string[] {
  return result.items.map((item) => {
    if (item.type === "agent_message") {
      return item.text;
    }
    if (item.type === "command_execution") {
      return `${item.status}: ${item.command}\n${item.aggregated_output}`;
    }
    if (item.type === "file_change") {
      return `${item.status}: ${item.changes.map((change) => `${change.kind}:${change.path}`).join(", ")}`;
    }
    return item.type;
  });
}

function parseJsonResponse<T>(raw: string, label: string): T {
  const trimmed = raw.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(withoutFence) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${label}: ${message}. Raw response: ${raw.slice(0, 1200)}`);
  }
}

const stringArraySchema = {
  type: "array",
  items: { type: "string" },
};

const networkPermissionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    shellNetwork: { type: "boolean" },
    webSearch: { type: "boolean" },
    mcpRead: { type: "boolean" },
    mcpWrite: { type: "boolean" },
  },
  required: ["shellNetwork", "webSearch", "mcpRead", "mcpWrite"],
};

const taskContractSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    taskId: { type: "string" },
    title: { type: "string" },
    role: {
      type: "string",
      enum: [
        "planner",
        "component-worker",
        "layout-worker",
        "screen-worker",
        "reviewer",
        "verifier",
        "merge-broker",
      ],
    },
    model: { type: "string" },
    modelTier: { type: "string", enum: ["spark", "mini", "gpt-5.5", "program"] },
    reasoningEffort: { type: "string", enum: ["none", "low", "medium", "high", "xhigh"] },
    objective: { type: "string" },
    readPaths: stringArraySchema,
    writePaths: stringArraySchema,
    forbiddenPaths: stringArraySchema,
    dependencies: stringArraySchema,
    acceptanceCriteria: stringArraySchema,
    validationTools: stringArraySchema,
    verificationCommands: stringArraySchema,
    riskLevel: { type: "string", enum: ["low", "medium", "high", "critical"] },
    expectedOutputs: stringArraySchema,
    notes: stringArraySchema,
    network: networkPermissionSchema,
  },
  required: [
    "taskId",
    "title",
    "role",
    "model",
    "modelTier",
    "reasoningEffort",
    "objective",
    "readPaths",
    "writePaths",
    "forbiddenPaths",
    "dependencies",
    "acceptanceCriteria",
    "validationTools",
    "verificationCommands",
    "riskLevel",
    "expectedOutputs",
    "notes",
    "network",
  ],
};

const taskDagSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    dagId: { type: "string" },
    tasks: { type: "array", items: taskContractSchema },
    edges: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          from: { type: "string" },
          to: { type: "string" },
          reason: { type: "string" },
        },
        required: ["from", "to", "reason"],
      },
    },
  },
  required: ["dagId", "tasks", "edges"],
};

const reviewIssueSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
    file: { type: "string" },
    evidence: { type: "string" },
    requiredFix: { type: "string" },
  },
  required: ["severity", "file", "evidence", "requiredFix"],
};

const commandRunResultSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    command: { type: "string" },
    status: { type: "string", enum: ["passed", "failed", "skipped"] },
    outputSummary: { type: "string" },
  },
  required: ["command", "status", "outputSummary"],
};

const reviewResultSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    reviewerId: { type: "string" },
    reviewType: { type: "string", enum: ["contract", "integration", "architecture", "security"] },
    status: { type: "string", enum: ["pass", "needs_changes", "reject"] },
    summary: { type: "string" },
    blockingIssues: { type: "array", items: reviewIssueSchema },
    nonBlockingIssues: { type: "array", items: reviewIssueSchema },
    commandsRun: { type: "array", items: commandRunResultSchema },
    suggestedFixTasks: { type: "array", items: taskContractSchema },
  },
  required: [
    "reviewerId",
    "reviewType",
    "status",
    "summary",
    "blockingIssues",
    "nonBlockingIssues",
    "commandsRun",
    "suggestedFixTasks",
  ],
};
