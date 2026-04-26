import type { ModelRunner } from "./model-runner.js";
import { MockModelRunner } from "./model-runner.js";
import { createMockPatchFile } from "../workspace/patch.js";
import type {
  AgentRole,
  ModelRunTelemetry,
  ProjectSpace,
  TaskContract,
  VerificationResult,
} from "../core/types.js";

export interface WorkerContext {
  project: ProjectSpace;
  workspacePath: string;
  codexOptions: object;
  inputFiles?: string[];
  taskContract: TaskContract;
  telemetry?: ModelRunTelemetry;
}

export interface WorkerResult {
  taskId: string;
  workerId: string;
  threadRunId?: string;
  status: "success" | "failed" | "needs_review";
  patchPath?: string;
  changedFiles: string[];
  reportPath?: string;
  logs: string[];
  summary: string;
  verification?: VerificationResult;
}

export interface AgentWorker {
  workerId: string;
  role: AgentRole;
  run(task: TaskContract, context: WorkerContext): Promise<WorkerResult>;
}

export interface PatchWorkerOptions {
  workerId?: string;
  modelRunner?: ModelRunner;
}

abstract class BasePatchWorker implements AgentWorker {
  readonly workerId: string;
  abstract readonly role: AgentRole;
  protected readonly modelRunner: ModelRunner;

  constructor(options: PatchWorkerOptions = {}) {
    this.workerId = options.workerId ?? `${this.constructor.name}-${Math.random().toString(36).slice(2)}`;
    this.modelRunner = options.modelRunner ?? new MockModelRunner();
  }

  async run(task: TaskContract, context: WorkerContext): Promise<WorkerResult> {
    if (task.role !== this.role) {
      return {
        taskId: task.taskId,
        workerId: this.workerId,
        threadRunId: context.telemetry?.threadRunId,
        status: "failed",
        changedFiles: [],
        logs: [`Role mismatch: worker=${this.role}, task=${task.role}`],
        summary: `Worker ${this.workerId} cannot run ${task.role} task ${task.taskId}.`,
      };
    }

    try {
      const output = await this.modelRunner.runWorker({
        task,
        workspacePath: context.workspacePath,
        telemetry: context.telemetry,
      });
      const patchPath = output.patchPath ?? (await createMockPatchFile(context.workspacePath, task));
      return {
        taskId: task.taskId,
        workerId: this.workerId,
        threadRunId: context.telemetry?.threadRunId,
        status: "success",
        patchPath,
        changedFiles: output.changedFiles,
        logs: output.logs,
        summary: output.summary,
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
        summary: `Worker ${this.workerId} failed task ${task.taskId}: ${message}`,
      };
    }
  }
}

export class SparkWorker extends BasePatchWorker {
  readonly role = "component-worker" as const;
}

export class MiniLayoutWorker extends BasePatchWorker {
  readonly role = "layout-worker" as const;
}

export class GptScreenWorker extends BasePatchWorker {
  readonly role = "screen-worker" as const;
}
