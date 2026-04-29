import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentWorker, WorkerContext, WorkerResult } from "../agents/worker.js";
import type { ModelRunner } from "../agents/model-runner.js";
import { MockModelRunner } from "../agents/model-runner.js";
import type { TaskContract, VerificationResult } from "../core/types.js";
import type { ReviewResult, ReviewType } from "./review-types.js";

export interface ReviewWorkerOptions {
  workerId?: string;
  reviewType?: ReviewType;
  modelRunner?: ModelRunner;
}

export function getReviewTypeFromTask(task: TaskContract): ReviewType {
  const note = task.notes?.find((value) => value.startsWith("reviewType:"));
  const fromNote = note?.slice("reviewType:".length);
  if (
    fromNote === "contract" ||
    fromNote === "integration" ||
    fromNote === "architecture" ||
    fromNote === "security"
  ) {
    return fromNote;
  }

  if (task.taskId.includes("integration")) {
    return "integration";
  }
  if (task.taskId.includes("architecture")) {
    return "architecture";
  }
  if (task.taskId.includes("security")) {
    return "security";
  }
  return "contract";
}

export class ReviewWorker implements AgentWorker {
  readonly workerId: string;
  readonly role = "reviewer" as const;
  private readonly reviewType?: ReviewType;
  private readonly modelRunner: ModelRunner;

  constructor(options: ReviewWorkerOptions = {}) {
    this.workerId = options.workerId ?? `reviewer-${Math.random().toString(36).slice(2)}`;
    this.reviewType = options.reviewType;
    this.modelRunner = options.modelRunner ?? new MockModelRunner();
  }

  async runReview(
    task: TaskContract,
    context: WorkerContext,
    verification?: VerificationResult
  ): Promise<ReviewResult> {
    const reviewType = this.reviewType ?? getReviewTypeFromTask(task);
    const result = await this.modelRunner.runReviewer({
      task,
      reviewType,
      verification,
      project: context.project,
      workspacePath: context.workspacePath,
      codexOptions: context.codexOptions,
      telemetry: context.telemetry,
    });
    const reportDir = path.join(context.workspacePath, ".agent-orchestrator", "reviews");
    await mkdir(reportDir, { recursive: true });
    await writeFile(
      path.join(reportDir, `${task.taskId}.review.json`),
      `${JSON.stringify(result, null, 2)}\n`,
      "utf8"
    );
    return result;
  }

  async run(task: TaskContract, context: WorkerContext): Promise<WorkerResult> {
    try {
      const review = await this.runReview(task, context);
      return {
        taskId: task.taskId,
        workerId: this.workerId,
        threadRunId: context.telemetry?.threadRunId,
        status: review.status === "reject" ? "failed" : review.status === "needs_changes" ? "needs_review" : "success",
        changedFiles: [],
        reportPath: path.join(
          context.workspacePath,
          ".agent-orchestrator",
          "reviews",
          `${task.taskId}.review.json`
        ),
        logs: [review.summary],
        summary: review.summary,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        taskId: task.taskId,
        workerId: this.workerId,
        threadRunId: context.telemetry?.threadRunId,
        status: "failed",
        changedFiles: [],
        logs: [message],
        summary: `Review failed: ${message}`,
      };
    }
  }
}
