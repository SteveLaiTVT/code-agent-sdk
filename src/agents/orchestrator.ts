import { createCodexOptions } from "./codex-options.js";
import type { ModelRunner } from "./model-runner.js";
import { MockModelRunner } from "./model-runner.js";
import { GptScreenWorker, MiniLayoutWorker, SparkWorker } from "./worker.js";
import type { AgentWorker, WorkerContext, WorkerResult } from "./worker.js";
import { SparkWorkerPool, WorkerPool } from "./worker-pool.js";
import { taskContractToScope } from "../core/task-contract.js";
import { assertTaskScopeSafe } from "../core/path-safety.js";
import { groupParallelTasks, validateTaskDAG } from "../core/task-dag.js";
import type {
  MergeResult,
  OrchestrationResult,
  ProjectSpace,
  TaskContract,
  TaskDAG,
  VerificationResult,
} from "../core/types.js";
import { MergeBroker } from "../merge/merge-broker.js";
import { ReviewAggregator } from "../review/review-aggregator.js";
import type { ReviewResult } from "../review/review-types.js";
import { ReviewWorker } from "../review/review-workers.js";
import { VerifierWorker } from "../verifier/verifier.js";
import { WorkspaceManager } from "../workspace/workspace-manager.js";

export interface AgentOrchestratorOptions {
  modelRunner?: ModelRunner;
  workspaceManager?: WorkspaceManager;
  mergeBroker?: MergeBroker;
  maxSparkWorkers?: number;
  maxMiniWorkers?: number;
  maxGpt55Workers?: number;
  executeVerificationCommands?: boolean;
  fullVerificationCommands?: string[];
}

export class AgentOrchestrator {
  private readonly modelRunner: ModelRunner;
  private readonly workspaceManager: WorkspaceManager;
  private readonly mergeBroker: MergeBroker;
  private readonly maxSparkWorkers: number;
  private readonly maxMiniWorkers: number;
  private readonly maxGpt55Workers: number;
  private readonly executeVerificationCommands: boolean;
  private readonly fullVerificationCommands: string[];

  constructor(options: AgentOrchestratorOptions = {}) {
    this.modelRunner = options.modelRunner ?? new MockModelRunner();
    this.workspaceManager = options.workspaceManager ?? new WorkspaceManager();
    this.mergeBroker = options.mergeBroker ?? new MergeBroker({ workspaceManager: this.workspaceManager });
    this.maxSparkWorkers = options.maxSparkWorkers ?? 4;
    this.maxMiniWorkers = options.maxMiniWorkers ?? 2;
    this.maxGpt55Workers = options.maxGpt55Workers ?? 1;
    this.executeVerificationCommands = options.executeVerificationCommands ?? false;
    this.fullVerificationCommands = options.fullVerificationCommands ?? [];
  }

  async run(requirement: string, project: ProjectSpace): Promise<OrchestrationResult> {
    const taskResults: WorkerResult[] = [];
    const mergeResults: MergeResult[] = [];
    const verificationResults: VerificationResult[] = [];
    const reviewResults: ReviewResult[] = [];

    let dag: TaskDAG;
    try {
      dag = await this.modelRunner.runPlanner(requirement, { project });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "failed",
        dag: { dagId: "planner-failed", tasks: [], edges: [] },
        taskResults,
        mergeResults,
        verificationResults,
        reviewResults,
        summary: `Planner failed: ${message}`,
      };
    }

    const dagValidation = validateTaskDAG(dag);
    if (!dagValidation.valid) {
      return {
        status: "failed",
        dag,
        taskResults,
        mergeResults,
        verificationResults,
        reviewResults,
        summary: `TaskDAG validation failed: ${dagValidation.errors.join("; ")}`,
      };
    }

    try {
      for (const task of dag.tasks) {
        assertTaskScopeSafe(project, task);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "failed",
        dag,
        taskResults,
        mergeResults,
        verificationResults,
        reviewResults,
        summary: `Task scope validation failed: ${message}`,
      };
    }

    const componentTasks = dag.tasks.filter((task) => task.role === "component-worker");
    const layoutTasks = dag.tasks.filter((task) => task.role === "layout-worker");
    const screenTasks = dag.tasks.filter((task) => task.role === "screen-worker");
    const verifierTasks = dag.tasks.filter((task) => task.role === "verifier");
    const reviewerTasks = dag.tasks.filter((task) => task.role === "reviewer");

    const componentResults = await this.runWorkerStage(
      project,
      componentTasks,
      new SparkWorkerPool(this.maxSparkWorkers),
      (_task, index) =>
        new SparkWorker({ workerId: `spark-worker-${index + 1}`, modelRunner: this.modelRunner })
    );
    taskResults.push(...componentResults);
    const componentMergeResults = await this.mergeBroker.mergeMany(
      project,
      componentTasks.map((task) => ({
        task,
        result: this.requireResult(task, componentResults),
      }))
    );
    mergeResults.push(...componentMergeResults);
    if (componentMergeResults.some((result) => result.status !== "merged")) {
      return this.failedAfterMerge(dag, taskResults, mergeResults, verificationResults, reviewResults);
    }

    const partialVerificationCommands = uniqueCommands(
      componentTasks.flatMap((task) => task.verificationCommands)
    );
    if (partialVerificationCommands.length > 0) {
      const partialVerification = await this.runVerification(
        project,
        partialVerificationCommands,
        "partial-verifier"
      );
      verificationResults.push(partialVerification);
    }

    const layoutResults = await this.runWorkerStage(
      project,
      layoutTasks,
      new WorkerPool({ concurrency: this.maxMiniWorkers }),
      (_task, index) =>
        new MiniLayoutWorker({ workerId: `mini-layout-worker-${index + 1}`, modelRunner: this.modelRunner })
    );
    taskResults.push(...layoutResults);
    const layoutMergeResults = await this.mergeBroker.mergeMany(
      project,
      layoutTasks.map((task) => ({
        task,
        result: this.requireResult(task, layoutResults),
      }))
    );
    mergeResults.push(...layoutMergeResults);
    if (layoutMergeResults.some((result) => result.status !== "merged")) {
      return this.failedAfterMerge(dag, taskResults, mergeResults, verificationResults, reviewResults);
    }

    const screenResults = await this.runWorkerStage(
      project,
      screenTasks,
      new WorkerPool({ concurrency: this.maxGpt55Workers }),
      (_task, index) =>
        new GptScreenWorker({ workerId: `gpt55-screen-worker-${index + 1}`, modelRunner: this.modelRunner })
    );
    taskResults.push(...screenResults);
    const screenMergeResults = await this.mergeBroker.mergeMany(
      project,
      screenTasks.map((task) => ({
        task,
        result: this.requireResult(task, screenResults),
      }))
    );
    mergeResults.push(...screenMergeResults);
    if (screenMergeResults.some((result) => result.status !== "merged")) {
      return this.failedAfterMerge(dag, taskResults, mergeResults, verificationResults, reviewResults);
    }

    for (const verifierTask of verifierTasks) {
      const worker = new VerifierWorker({
        workerId: verifierTask.taskId,
        executeCommands: this.executeVerificationCommands,
      });
      const workspacePath = await this.workspaceManager.createTaskWorkspace(project, verifierTask);
      const result = await worker.run(verifierTask, {
        project,
        workspacePath,
        codexOptions: createCodexOptions({
          role: "verifier",
          project,
          taskScope: taskContractToScope(verifierTask),
        }),
        taskContract: verifierTask,
      });
      taskResults.push(result);
      if (result.verification) {
        verificationResults.push(result.verification);
      }
    }

    if (this.fullVerificationCommands.length > 0) {
      const fullVerification = await this.runVerification(
        project,
        this.fullVerificationCommands,
        "full-chain-verifier"
      );
      verificationResults.push(fullVerification);
    }
    if (verificationResults.some((result) => result.status === "failed")) {
      return {
        status: "failed",
        dag,
        taskResults,
        mergeResults,
        verificationResults,
        reviewResults,
        summary: "Verification failed before review.",
      };
    }

    reviewResults.push(...(await this.runReviewers(project, reviewerTasks)));
    const reviewAggregation = new ReviewAggregator().aggregate(reviewResults);

    return {
      status: reviewAggregation.status,
      dag,
      taskResults,
      mergeResults,
      verificationResults,
      reviewResults,
      summary:
        reviewAggregation.status === "pass"
          ? "Orchestration completed successfully."
          : reviewAggregation.summary,
    };
  }

  private async runWorkerStage(
    project: ProjectSpace,
    tasks: TaskContract[],
    pool: WorkerPool,
    createWorker: (task: TaskContract, index: number) => AgentWorker
  ): Promise<WorkerResult[]> {
    if (tasks.length === 0) {
      return [];
    }

    const groupedTasks = groupParallelTasks(tasks).flat();
    return pool.run(
      groupedTasks,
      createWorker,
      async (task): Promise<WorkerContext> => {
        const workspacePath = await this.workspaceManager.createTaskWorkspace(project, task);
        return {
          project,
          workspacePath,
          codexOptions: createCodexOptions({
            role: task.role,
            project,
            taskScope: taskContractToScope(task),
          }),
          taskContract: task,
          inputFiles: task.readPaths,
        };
      }
    );
  }

  private async runVerification(
    project: ProjectSpace,
    commands: string[],
    workerId: string
  ): Promise<VerificationResult> {
    const worker = new VerifierWorker({
      workerId,
      executeCommands: this.executeVerificationCommands,
    });
    return worker.verify(commands, project.root);
  }

  private async runReviewers(project: ProjectSpace, tasks: TaskContract[]): Promise<ReviewResult[]> {
    return Promise.all(
      tasks.map(async (task) => {
        const workspacePath = await this.workspaceManager.createReviewWorkspace(project, task.taskId);
        const worker = new ReviewWorker({
          workerId: `${task.taskId}-worker`,
          modelRunner: this.modelRunner,
        });
        return worker.runReview(task, {
          project,
          workspacePath,
          codexOptions: createCodexOptions({
            role: "reviewer",
            project,
            taskScope: {
              readablePaths: task.readPaths,
              reportPaths: [".agent-orchestrator/reviews", ".agent-orchestrator/tmp"],
              forbiddenPaths: task.forbiddenPaths,
            },
          }),
          taskContract: task,
          inputFiles: task.readPaths,
        });
      })
    );
  }

  private requireResult(task: TaskContract, results: WorkerResult[]): WorkerResult {
    const result = results.find((candidate) => candidate.taskId === task.taskId);
    if (!result) {
      return {
        taskId: task.taskId,
        workerId: "orchestrator",
        status: "failed",
        changedFiles: [],
        logs: [`Missing worker result for ${task.taskId}`],
        summary: `Missing worker result for ${task.taskId}`,
      };
    }
    return result;
  }

  private failedAfterMerge(
    dag: TaskDAG,
    taskResults: WorkerResult[],
    mergeResults: MergeResult[],
    verificationResults: VerificationResult[],
    reviewResults: ReviewResult[]
  ): OrchestrationResult {
    return {
      status: "failed",
      dag,
      taskResults,
      mergeResults,
      verificationResults,
      reviewResults,
      summary: "Merge broker rejected or failed one or more worker patches.",
    };
  }
}

function uniqueCommands(commands: string[]): string[] {
  return [...new Set(commands.map((command) => command.trim()).filter(Boolean))];
}
