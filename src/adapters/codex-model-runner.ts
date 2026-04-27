import type {
  ModelRunner,
  ModelRunnerPlannerContext,
  ModelRunnerReviewerInput,
  ModelRunnerWorkerInput,
  ModelRunnerWorkerOutput,
} from "../agents/model-runner.js";
import {
  Codex,
  type Input,
  type RunResult,
  type Thread,
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

export const defaultCodexModelRunnerAdapterConfig: CodexModelRunnerAdapterConfig = {
  plannerModel: "gpt-5.5",
  componentWorkerModel: "gpt-5.3-codex-spark",
  layoutWorkerModel: "gpt-5.4-mini",
  screenWorkerModel: "gpt-5.5",
  reviewerModel: "gpt-5.5",
};

export class CodexModelRunnerAdapter implements ModelRunner {
  readonly config: CodexModelRunnerAdapterConfig;
  private readonly codex: Codex;

  constructor(config: Partial<CodexModelRunnerAdapterConfig> = {}, codex = new Codex()) {
    this.config = {
      ...defaultCodexModelRunnerAdapterConfig,
      ...config,
    };
    this.codex = codex;
  }

  async runPlanner(requirement: string, context: ModelRunnerPlannerContext = {}): Promise<TaskDAG> {
    const project = context.project;
    if (!project) {
      throw new Error("Codex planner requires ProjectSpace context.");
    }

    const thread = this.codex.startThread({
      model: this.config.plannerModel,
      modelReasoningEffort: "xhigh",
      sandboxMode: "read-only",
      workingDirectory: project.root,
      approvalPolicy: "never",
      webSearchEnabled: false,
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
    const thread = this.codex.startThread({
      model,
      modelReasoningEffort: reasoningForTask(input.task),
      sandboxMode: "workspace-write",
      workingDirectory: input.workspacePath,
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchEnabled: false,
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
    const thread = this.codex.startThread({
      model,
      modelReasoningEffort: input.reviewType === "security" ? "xhigh" : "high",
      sandboxMode: "workspace-write",
      workingDirectory: input.workspacePath,
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchEnabled: false,
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
}

async function runThreadStreamed(
  thread: Thread,
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
    "- Always include model, reasoningEffort, expectedOutputs, and notes. Use empty arrays for no outputs/notes.",
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
