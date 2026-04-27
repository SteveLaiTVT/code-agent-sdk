import type { ReviewResult } from "../review/review-types.js";
import { emitThreadEvent } from "../core/orchestration-stream.js";
import type {
  ModelRunTelemetry,
  PlanRevisionContext,
  ProjectSpace,
  TaskContract,
  TaskDAG,
  VerificationResult,
} from "../core/types.js";

export interface ModelRunnerWorkerInput {
  task: TaskContract;
  workspacePath: string;
  telemetry?: ModelRunTelemetry;
}

export interface ModelRunnerWorkerOutput {
  summary: string;
  changedFiles: string[];
  logs: string[];
  patchPath?: string;
}

export interface ModelRunnerReviewerInput {
  task: TaskContract;
  reviewType: ReviewResult["reviewType"];
  project?: ProjectSpace;
  workspacePath?: string;
  verification?: VerificationResult;
  telemetry?: ModelRunTelemetry;
}

export interface ModelRunnerPlannerContext {
  project?: ProjectSpace;
  telemetry?: ModelRunTelemetry;
  planRevision?: PlanRevisionContext;
}

export interface ModelRunner {
  runPlanner(requirement: string, context?: ModelRunnerPlannerContext): Promise<TaskDAG>;
  runWorker(input: ModelRunnerWorkerInput): Promise<ModelRunnerWorkerOutput>;
  runReviewer(input: ModelRunnerReviewerInput): Promise<ReviewResult>;
}

function generatedPath(fileName: string): string {
  return `src/examples/generated-task-board/${fileName}`;
}

export class MockModelRunner implements ModelRunner {
  async runPlanner(requirement: string, context: ModelRunnerPlannerContext = {}): Promise<TaskDAG> {
    const implementationTaskIds = [
      "spark-status-badge",
      "spark-task-card",
      "mini-task-card-grid",
      "gpt-task-board-screen",
    ];
    const reviewTaskIds = [
      "review-contract",
      "review-integration",
      "review-architecture",
      "review-security",
    ];

    const tasks: TaskContract[] = [
      {
        taskId: "spark-status-badge",
        title: "Implement StatusBadge pure component",
        role: "component-worker",
        model: "gpt-5.3-codex-spark",
        modelTier: "spark",
        reasoningEffort: "low",
        objective: `Create the low-risk StatusBadge piece for: ${requirement}`,
        readPaths: ["src"],
        writePaths: [generatedPath("status-badge.ts")],
        forbiddenPaths: ["package.json", ".env", ".git", "node_modules"],
        dependencies: [],
        acceptanceCriteria: ["StatusBadge is isolated and has no layout or screen orchestration logic."],
        validationTools: ["npm"],
        verificationCommands: ["npm run build"],
        riskLevel: "low",
        expectedOutputs: [],
        notes: [],
      },
      {
        taskId: "spark-task-card",
        title: "Implement TaskCard pure component",
        role: "component-worker",
        model: "gpt-5.3-codex-spark",
        modelTier: "spark",
        reasoningEffort: "low",
        objective: `Create the low-risk TaskCard piece for: ${requirement}`,
        readPaths: ["src"],
        writePaths: [generatedPath("task-card.ts")],
        forbiddenPaths: ["package.json", ".env", ".git", "node_modules"],
        dependencies: [],
        acceptanceCriteria: ["TaskCard is isolated and delegates status rendering to StatusBadge contract."],
        validationTools: ["npm"],
        verificationCommands: ["npm run build"],
        riskLevel: "low",
        expectedOutputs: [],
        notes: [],
      },
      {
        taskId: "mini-task-card-grid",
        title: "Implement TaskCardGrid layout",
        role: "layout-worker",
        model: "gpt-5.4-mini",
        modelTier: "mini",
        reasoningEffort: "medium",
        objective: "Compose task cards into a grid layout with loading and empty states.",
        readPaths: ["src", generatedPath("status-badge.ts"), generatedPath("task-card.ts")],
        writePaths: [generatedPath("task-card-grid.ts")],
        forbiddenPaths: ["package.json", ".env", ".git", "node_modules"],
        dependencies: ["spark-status-badge", "spark-task-card"],
        acceptanceCriteria: ["Layout depends on component contracts and avoids screen-level state loading."],
        validationTools: ["npm"],
        verificationCommands: ["npm run build"],
        riskLevel: "medium",
        expectedOutputs: [],
        notes: [],
      },
      {
        taskId: "gpt-task-board-screen",
        title: "Implement TaskBoardScreen logic",
        role: "screen-worker",
        model: "gpt-5.5",
        modelTier: "gpt-5.5",
        reasoningEffort: "high",
        objective: "Coordinate TaskCardGrid data, filters, errors, and routing-level state.",
        readPaths: ["src", generatedPath("task-card-grid.ts")],
        writePaths: [generatedPath("task-board-screen.ts")],
        forbiddenPaths: ["package.json", ".env", ".git", "node_modules"],
        dependencies: ["mini-task-card-grid"],
        acceptanceCriteria: ["Screen owns data and orchestration; layout remains presentational."],
        validationTools: ["npm"],
        verificationCommands: ["npm run build"],
        riskLevel: "medium",
        expectedOutputs: [],
        notes: [],
      },
      {
        taskId: "verify-full-chain",
        title: "Run full verification",
        role: "verifier",
        model: "program",
        modelTier: "program",
        reasoningEffort: "none",
        objective: "Run typecheck, lint, unit test, build or configured equivalents.",
        readPaths: ["src", "test", "package.json"],
        writePaths: [],
        forbiddenPaths: ["src", "package.json", ".env", ".git", "node_modules"],
        dependencies: implementationTaskIds,
        acceptanceCriteria: ["Verification result is structured."],
        validationTools: ["npm"],
        verificationCommands: ["npm run build", "npm test"],
        riskLevel: "low",
        expectedOutputs: [],
        notes: [],
      },
      ...reviewTaskIds.map((taskId): TaskContract => {
        const reviewType = taskId.replace("review-", "") as ReviewResult["reviewType"];
        return {
          taskId,
          title: `${reviewType} review`,
          role: "reviewer",
          model: "gpt-5.5",
          modelTier: "gpt-5.5",
          reasoningEffort: reviewType === "security" ? "xhigh" : "high",
          objective: `Run ${reviewType} review without modifying source.`,
          readPaths: ["src", "test", "package.json"],
          writePaths: [],
          forbiddenPaths: [".env", ".git", "node_modules"],
          dependencies: implementationTaskIds,
          acceptanceCriteria: ["Review report is structured and includes blocking/non-blocking issues."],
          validationTools: reviewType === "integration" ? ["npm"] : [],
          verificationCommands: reviewType === "integration" ? ["npm run build"] : [],
          riskLevel: "low",
          expectedOutputs: [`.agent-orchestrator/reviews/${taskId}.json`],
          notes: [`reviewType:${reviewType}`],
        };
      }),
    ];

    const dag: TaskDAG = {
      dagId: `mock-task-board-${Date.now()}`,
      tasks,
      edges: tasks.flatMap((task) =>
        task.dependencies.map((dependency) => ({
          from: dependency,
          to: task.taskId,
          reason: "Task contract dependency",
        }))
      ),
    };
    emitMockTurn(context.telemetry, JSON.stringify(dag), 16);
    return dag;
  }

  async runWorker(input: ModelRunnerWorkerInput): Promise<ModelRunnerWorkerOutput> {
    const output = {
      summary: `${input.task.role} completed ${input.task.title} in mock mode.`,
      changedFiles: input.task.writePaths,
      logs: [`mock-runner:${input.task.taskId}`, `workspace:${input.workspacePath}`],
    };
    emitMockTurn(input.telemetry, output.summary, 8);
    return output;
  }

  async runReviewer(input: ModelRunnerReviewerInput): Promise<ReviewResult> {
    const result: ReviewResult = {
      reviewerId: `mock-${input.reviewType}-reviewer`,
      reviewType: input.reviewType,
      status: "pass",
      summary: `${input.reviewType} review passed in mock mode.`,
      blockingIssues: [],
      nonBlockingIssues: [],
      commandsRun:
        input.task.verificationCommands.length > 0
          ? input.task.verificationCommands.map((command) => ({
              command,
              status: "skipped",
              outputSummary: "Skipped by mock reviewer.",
            }))
          : [],
      suggestedFixTasks: [],
    };
    emitMockTurn(input.telemetry, JSON.stringify(result), 6);
    return result;
  }
}

function emitMockTurn(
  telemetry: ModelRunTelemetry | undefined,
  text: string,
  tokenBase: number
): void {
  if (!telemetry) {
    return;
  }
  emitThreadEvent(telemetry, {
    type: "thread.started",
    thread_id: `mock-${telemetry.threadRunId}`,
  });
  emitThreadEvent(telemetry, { type: "turn.started" });
  emitThreadEvent(telemetry, {
    type: "item.completed",
    item: {
      id: `mock-message-${telemetry.threadRunId}`,
      type: "agent_message",
      text,
    },
  });
  emitThreadEvent(telemetry, {
    type: "turn.completed",
    usage: {
      input_tokens: tokenBase,
      cached_input_tokens: 0,
      output_tokens: tokenBase + 1,
      reasoning_output_tokens: Math.max(0, tokenBase - 2),
    },
  });
}
