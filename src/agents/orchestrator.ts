import { createCodexOptions } from "./codex-options.js";
import type { ModelRunner } from "./model-runner.js";
import { MockModelRunner } from "./model-runner.js";
import { GptScreenWorker, MiniLayoutWorker, SparkWorker } from "./worker.js";
import type { AgentWorker, WorkerResult } from "./worker.js";
import {
  buildThreadRunTrace,
  collectOrchestrationStream,
  summarizeModelUsage,
} from "../core/orchestration-stream.js";
import { isImplementationTask, taskContractToScope } from "../core/task-contract.js";
import { assertTaskScopeSafe, hasPathOverlap } from "../core/path-safety.js";
import { validateTaskDAG } from "../core/task-dag.js";
import type {
  AgentRole,
  MergeResult,
  ModelRunTelemetry,
  OrchestrationEvent,
  OrchestrationEventSink,
  OrchestrationResult,
  OrchestrationStream,
  PlanReviewConfig,
  PlanReviewController,
  PlanReviewOption,
  PlanRevisionContext,
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
  plannerModel?: string;
  planReview?: PlanReviewConfig;
  preMergeValidation?: PreMergeValidationOptions;
  maxSparkWorkers?: number;
  maxMiniWorkers?: number;
  maxGpt55Workers?: number;
  executeVerificationCommands?: boolean;
  fullVerificationCommands?: string[];
}

interface ImplementationRunResult {
  taskResults: WorkerResult[];
  mergeResults: MergeResult[];
  success: boolean;
  summary?: string;
}

export interface PreMergeValidationOptions {
  enabled?: boolean;
  commands?: string[];
}

type PlanReviewDecision =
  | { action: "approve" }
  | { action: "revise"; feedback: string }
  | { action: "cancel"; reason?: string };

const DEFAULT_PLAN_REVIEW_OPTIONS: PlanReviewOption[] = [
  {
    action: "approve",
    label: "Approve",
    description: "Continue with this TaskDAG and start implementation.",
    requiresFeedback: false,
  },
  {
    action: "revise",
    label: "Revise",
    description: "Send feedback to the planner and request a revised TaskDAG.",
    requiresFeedback: true,
  },
  {
    action: "cancel",
    label: "Cancel",
    description: "End this run without executing code.",
    requiresFeedback: false,
  },
];

const MANUAL_PLAN_REVIEW_RUN_ERROR =
  "Manual plan review requires the streamed API. Use runStreamed() or runCodingTaskStreamed() so the caller can approve, revise, or cancel the plan.";

export class AgentOrchestrator {
  private readonly modelRunner: ModelRunner;
  private readonly workspaceManager: WorkspaceManager;
  private readonly mergeBroker: MergeBroker;
  private readonly plannerModel: string;
  private readonly planReview: PlanReviewConfig;
  private readonly preMergeValidation: Required<PreMergeValidationOptions>;
  private readonly maxSparkWorkers: number;
  private readonly maxMiniWorkers: number;
  private readonly maxGpt55Workers: number;
  private readonly executeVerificationCommands: boolean;
  private readonly fullVerificationCommands: string[];

  constructor(options: AgentOrchestratorOptions = {}) {
    this.modelRunner = options.modelRunner ?? new MockModelRunner();
    this.workspaceManager = options.workspaceManager ?? new WorkspaceManager();
    this.mergeBroker = options.mergeBroker ?? new MergeBroker({ workspaceManager: this.workspaceManager });
    this.plannerModel = options.plannerModel ?? getPlannerModelFromRunner(this.modelRunner) ?? "gpt-5.5";
    this.planReview = options.planReview ?? { mode: "auto" };
    this.preMergeValidation = {
      enabled: options.preMergeValidation?.enabled ?? true,
      commands: options.preMergeValidation?.commands ?? [],
    };
    this.maxSparkWorkers = options.maxSparkWorkers ?? 4;
    this.maxMiniWorkers = options.maxMiniWorkers ?? 2;
    this.maxGpt55Workers = options.maxGpt55Workers ?? 1;
    this.executeVerificationCommands = options.executeVerificationCommands ?? false;
    this.fullVerificationCommands = options.fullVerificationCommands ?? [];
  }

  runStreamed(requirement: string, project: ProjectSpace): OrchestrationStream {
    const runId = createRunId();
    const queue = new AsyncEventQueue<OrchestrationEvent>();
    const eventLog: OrchestrationEvent[] = [];
    const planReviewCoordinator =
      this.planReview.mode === "manual" ? new PlanReviewCoordinator() : undefined;
    const emit: OrchestrationEventSink = (event) => {
      eventLog.push(event);
      queue.push(event);
    };

    const result = this.runInternal(
      requirement,
      project,
      runId,
      emit,
      eventLog,
      planReviewCoordinator
    )
      .then((orchestrationResult) => {
        if (orchestrationResult.status === "failed") {
          emit({
            type: "run.failed",
            runId,
            timestamp: now(),
            error: orchestrationResult.summary,
            result: orchestrationResult,
          });
        } else {
          emit({
            type: "run.completed",
            runId,
            timestamp: now(),
            result: orchestrationResult,
          });
        }
        queue.close();
        return orchestrationResult;
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        const fallback = this.finishResult(
          "failed",
          { dagId: "orchestrator-failed", tasks: [], edges: [] },
          [],
          [],
          [],
          [],
          `Orchestrator failed: ${message}`,
          eventLog
        );
        emit({
          type: "run.failed",
          runId,
          timestamp: now(),
          error: message,
          result: fallback,
        });
        queue.close();
        return fallback;
      });

    return {
      events: queue,
      result,
      planReview: planReviewCoordinator,
    };
  }

  async run(requirement: string, project: ProjectSpace): Promise<OrchestrationResult> {
    if (this.planReview.mode === "manual") {
      throw new Error(MANUAL_PLAN_REVIEW_RUN_ERROR);
    }
    const stream = this.runStreamed(requirement, project);
    return collectOrchestrationStream(stream.events);
  }

  private async runInternal(
    requirement: string,
    project: ProjectSpace,
    runId: string,
    emit: OrchestrationEventSink,
    eventLog: OrchestrationEvent[],
    planReviewCoordinator?: PlanReviewCoordinator
  ): Promise<OrchestrationResult> {
    const taskResults: WorkerResult[] = [];
    const mergeResults: MergeResult[] = [];
    const verificationResults: VerificationResult[] = [];
    const reviewResults: ReviewResult[] = [];

    emit({
      type: "run.started",
      runId,
      timestamp: now(),
      requirement,
      project,
    });

    let approvedDag: TaskDAG | undefined;
    let revisionIndex = 0;
    let planRevision: PlanRevisionContext | undefined;

    while (!approvedDag) {
      const plannerTelemetry = this.createTelemetry({
        runId,
        threadRunId: createThreadRunId(runId, `planner-${revisionIndex}`),
        role: "planner",
        model: this.plannerModel,
        reasoningEffort: "xhigh",
        emit,
      });

      let plannedDag: TaskDAG;
      try {
        emit({
          type: "planner.started",
          runId,
          timestamp: now(),
          model: this.plannerModel,
          reasoningEffort: "xhigh",
        });
        plannedDag = await this.modelRunner.runPlanner(requirement, {
          project,
          codexOptions: createCodexOptions({
            role: "planner",
            project,
          }),
          telemetry: plannerTelemetry,
          planRevision,
        });
        emit({
          type: "planner.completed",
          runId,
          timestamp: now(),
          dag: plannedDag,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emit({
          type: "planner.failed",
          runId,
          timestamp: now(),
          error: message,
        });
        return this.finishResult(
          "failed",
          { dagId: "planner-failed", tasks: [], edges: [] },
          taskResults,
          mergeResults,
          verificationResults,
          reviewResults,
          `Planner failed: ${message}`,
          eventLog
        );
      }

      const validationFailure = this.validatePlannedDag(project, plannedDag);
      if (validationFailure) {
        return this.finishResult(
          "failed",
          plannedDag,
          taskResults,
          mergeResults,
          verificationResults,
          reviewResults,
          validationFailure,
          eventLog
        );
      }

      if (!planReviewCoordinator) {
        approvedDag = plannedDag;
        break;
      }

      const decisionPromise = planReviewCoordinator.waitForDecision();
      emit({
        type: "plan.review.required",
        runId,
        timestamp: now(),
        dag: plannedDag,
        revisionIndex,
        options: this.planReviewOptions(),
      });
      const decision = await decisionPromise;

      if (decision.action === "approve") {
        emit({
          type: "plan.review.approved",
          runId,
          timestamp: now(),
          dag: plannedDag,
          revisionIndex,
        });
        approvedDag = plannedDag;
        break;
      }

      if (decision.action === "cancel") {
        emit({
          type: "plan.review.cancelled",
          runId,
          timestamp: now(),
          dag: plannedDag,
          revisionIndex,
          reason: decision.reason,
        });
        return this.finishResult(
          "cancelled",
          plannedDag,
          taskResults,
          mergeResults,
          verificationResults,
          reviewResults,
          decision.reason ? `Plan review cancelled: ${decision.reason}` : "Plan review cancelled.",
          eventLog
        );
      }

      emit({
        type: "plan.review.revision_requested",
        runId,
        timestamp: now(),
        dag: plannedDag,
        revisionIndex,
        feedback: decision.feedback,
      });
      revisionIndex += 1;
      planRevision = {
        originalRequirement: requirement,
        previousDag: plannedDag,
        feedback: decision.feedback,
        revisionIndex,
      };
    }

    const dag = approvedDag;

    const implementationTasks = dag.tasks.filter(isImplementationTask);
    const verifierTasks = dag.tasks.filter((task) => task.role === "verifier");
    const reviewerTasks = dag.tasks.filter((task) => task.role === "reviewer");

    const implementationRun = await this.runImplementationDag(
      project,
      implementationTasks,
      runId,
      emit
    );
    taskResults.push(...implementationRun.taskResults);
    mergeResults.push(...implementationRun.mergeResults);
    if (!implementationRun.success) {
      return this.finishResult(
        "failed",
        dag,
        taskResults,
        mergeResults,
        verificationResults,
        reviewResults,
        implementationRun.summary ?? "Merge broker rejected or failed one or more worker patches.",
        eventLog
      );
    }

    if (!this.preMergeValidation.enabled) {
      const partialVerificationCommands = uniqueCommands(
        implementationTasks.flatMap((task) => task.verificationCommands)
      );
      if (partialVerificationCommands.length > 0) {
        const partialVerification = await this.runVerification(
          project,
          partialVerificationCommands,
          "partial-verifier",
          runId,
          emit
        );
        verificationResults.push(partialVerification);
      }
    }

    for (const verifierTask of verifierTasks) {
      const result = await this.runVerifierTask(project, verifierTask, runId, emit);
      taskResults.push(result);
      if (result.verification) {
        verificationResults.push(result.verification);
      }
    }

    if (this.fullVerificationCommands.length > 0) {
      const fullVerification = await this.runVerification(
        project,
        this.fullVerificationCommands,
        "full-chain-verifier",
        runId,
        emit
      );
      verificationResults.push(fullVerification);
    }
    if (verificationResults.some((result) => result.status === "failed")) {
      return this.finishResult(
        "failed",
        dag,
        taskResults,
        mergeResults,
        verificationResults,
        reviewResults,
        "Verification failed before review.",
        eventLog
      );
    }

    reviewResults.push(...(await this.runReviewers(project, reviewerTasks, runId, emit)));
    const reviewAggregation = new ReviewAggregator().aggregate(reviewResults);

    return this.finishResult(
      reviewAggregation.status,
      dag,
      taskResults,
      mergeResults,
      verificationResults,
      reviewResults,
      reviewAggregation.status === "pass"
        ? "Orchestration completed successfully."
        : reviewAggregation.summary,
      eventLog
    );
  }

  private validatePlannedDag(project: ProjectSpace, dag: TaskDAG): string | undefined {
    const dagValidation = validateTaskDAG(dag);
    if (!dagValidation.valid) {
      return `TaskDAG validation failed: ${dagValidation.errors.join("; ")}`;
    }

    try {
      for (const task of dag.tasks) {
        assertTaskScopeSafe(project, task);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Task scope validation failed: ${message}`;
    }

    return undefined;
  }

  private planReviewOptions(): PlanReviewOption[] {
    const options =
      this.planReview.options && this.planReview.options.length > 0
        ? this.planReview.options
        : DEFAULT_PLAN_REVIEW_OPTIONS;
    return options.map((option) => ({ ...option }));
  }

  private async runImplementationDag(
    project: ProjectSpace,
    tasks: TaskContract[],
    runId: string,
    emit: OrchestrationEventSink
  ): Promise<ImplementationRunResult> {
    const pending = new Map(tasks.map((task) => [task.taskId, task]));
    const completed = new Set<string>();
    const taskResults: WorkerResult[] = [];
    const mergeResults: MergeResult[] = [];

    while (pending.size > 0) {
      const readyTasks = [...pending.values()].filter((task) =>
        task.dependencies.every((dependency) => completed.has(dependency) || !pending.has(dependency))
      );
      if (readyTasks.length === 0) {
        const blocked = [...pending.keys()].join(", ");
        throw new Error(`No implementation tasks are ready; blocked tasks: ${blocked}`);
      }

      const batch = this.selectRunnableBatch(readyTasks);
      const batchResults = await Promise.all(
        batch.map((task, index) => this.runImplementationTask(project, task, index, runId, emit))
      );
      taskResults.push(...batchResults);

      const failedResult = batchResults.find((result) => result.status !== "success");
      if (failedResult) {
        return {
          taskResults,
          mergeResults,
          success: false,
          summary: failedResult.summary,
        };
      }

      const batchMergeResults = await this.mergeBroker.mergeMany(
        project,
        batch.map((task) => ({
          task,
          result: this.requireResult(task, batchResults),
        }))
      );
      for (const mergeResult of batchMergeResults) {
        const task = batch.find((candidate) => candidate.taskId === mergeResult.taskId);
        if (task) {
          emit({
            type: "merge.completed",
            runId,
            timestamp: now(),
            task,
            result: mergeResult,
          });
        }
      }
      mergeResults.push(...batchMergeResults);

      if (batchMergeResults.some((result) => result.status !== "merged")) {
        return {
          taskResults,
          mergeResults,
          success: false,
          summary: "Merge broker rejected or failed one or more worker patches.",
        };
      }

      for (const task of batch) {
        completed.add(task.taskId);
        pending.delete(task.taskId);
      }
    }

    return { taskResults, mergeResults, success: true };
  }

  private selectRunnableBatch(readyTasks: TaskContract[]): TaskContract[] {
    const batch: TaskContract[] = [];
    const roleCounts = new Map<AgentRole, number>();

    for (const task of readyTasks) {
      const currentRoleCount = roleCounts.get(task.role) ?? 0;
      if (currentRoleCount >= this.maxConcurrencyForRole(task.role)) {
        continue;
      }
      if (!batch.every((existing) => canRunTogether(existing, task))) {
        continue;
      }
      batch.push(task);
      roleCounts.set(task.role, currentRoleCount + 1);
    }

    return batch.length > 0 ? batch : [readyTasks[0]];
  }

  private async runImplementationTask(
    project: ProjectSpace,
    task: TaskContract,
    index: number,
    runId: string,
    emit: OrchestrationEventSink
  ): Promise<WorkerResult> {
    const worker = this.createImplementationWorker(task, index);
    const threadRunId = createThreadRunId(runId, task.taskId);
    const telemetry = this.createTelemetry({
      runId,
      threadRunId,
      taskId: task.taskId,
      workerId: worker.workerId,
      role: task.role,
      model: modelForTask(task),
      reasoningEffort: task.reasoningEffort,
      emit,
    });

    emit({
      type: "task.started",
      runId,
      timestamp: now(),
      task,
      workerId: worker.workerId,
      threadRunId,
    });
    const workspacePath = await this.workspaceManager.createTaskWorkspace(project, task);
    const workspaceProject = {
      ...project,
      root: workspacePath,
    };
    let result = await worker.run(task, {
      project,
      workspacePath,
      codexOptions: createCodexOptions({
        role: task.role,
        project: workspaceProject,
        taskScope: taskContractToScope(task),
      }),
      taskContract: task,
      inputFiles: task.readPaths,
      telemetry,
    });

    if (result.status === "success") {
      const validation = await this.runPreMergeValidation(
        project,
        task,
        result,
        worker.workerId,
        threadRunId,
        runId,
        emit
      );
      if (validation) {
        result = {
          ...result,
          status: validation.status === "failed" ? "failed" : result.status,
          verification: validation,
          logs: [
            ...result.logs,
            ...validation.commands.map(
              (command) => `${command.status}: ${command.command} - ${command.outputSummary}`
            ),
          ],
          summary:
            validation.status === "failed"
              ? `Pre-merge validation failed for ${task.taskId}.`
              : result.summary,
        };
      }
    }

    if (result.status === "success") {
      emit({
        type: "task.completed",
        runId,
        timestamp: now(),
        task,
        workerId: worker.workerId,
        threadRunId,
        result,
      });
    } else {
      emit({
        type: "task.failed",
        runId,
        timestamp: now(),
        task,
        workerId: worker.workerId,
        threadRunId,
        error: result.summary,
      });
    }
    return result;
  }

  private async runPreMergeValidation(
    project: ProjectSpace,
    task: TaskContract,
    result: WorkerResult,
    workerId: string,
    threadRunId: string,
    runId: string,
    emit: OrchestrationEventSink
  ): Promise<VerificationResult | undefined> {
    const commands = this.preMergeValidationCommandsFor(task, result);
    if (!this.preMergeValidation.enabled || commands.length === 0 || !result.patchPath) {
      return undefined;
    }

    const validationWorkspace = await this.workspaceManager.createValidationWorkspace(
      project,
      `${task.taskId}-pre-merge`
    );
    try {
      const validationProject: ProjectSpace = {
        ...project,
        root: validationWorkspace,
      };
      const applyResult = await this.workspaceManager.applyPatch(validationProject, result.patchPath);
      let validation: VerificationResult;
      if (applyResult.status === "failed") {
        validation = {
          status: "failed",
          commands: [
            {
              command: "apply patch",
              status: "failed",
              outputSummary: applyResult.errors.join("\n") || applyResult.summary,
            },
          ],
          summary: `Pre-merge validation could not apply patch for ${task.taskId}.`,
        };
      } else {
        const verifier = new VerifierWorker({
          workerId: `${workerId}-pre-merge-validation`,
          executeCommands: this.executeVerificationCommands,
        });
        validation = await verifier.verify(commands, validationWorkspace);
      }

      emit({
        type: "task.validation.completed",
        runId,
        timestamp: now(),
        task,
        workerId,
        threadRunId,
        stage: "pre-merge",
        result: validation,
      });
      return validation;
    } finally {
      await this.workspaceManager.cleanupValidationWorkspace(validationWorkspace);
    }
  }

  private preMergeValidationCommandsFor(task: TaskContract, result: WorkerResult): string[] {
    if (!this.preMergeValidation.enabled) {
      return [];
    }
    return uniqueCommands([
      ...this.preMergeValidation.commands,
      ...task.verificationCommands,
    ]);
  }

  private createImplementationWorker(task: TaskContract, index: number): AgentWorker {
    switch (task.role) {
      case "component-worker":
        return new SparkWorker({ workerId: `spark-worker-${index + 1}`, modelRunner: this.modelRunner });
      case "layout-worker":
        return new MiniLayoutWorker({
          workerId: `mini-layout-worker-${index + 1}`,
          modelRunner: this.modelRunner,
        });
      case "screen-worker":
        return new GptScreenWorker({
          workerId: `screen-worker-${index + 1}`,
          modelRunner: this.modelRunner,
        });
      default:
        throw new Error(`Task ${task.taskId} is not an implementation task: ${task.role}`);
    }
  }

  private async runVerifierTask(
    project: ProjectSpace,
    verifierTask: TaskContract,
    runId: string,
    emit: OrchestrationEventSink
  ): Promise<WorkerResult> {
    const worker = new VerifierWorker({
      workerId: verifierTask.taskId,
      executeCommands: this.executeVerificationCommands,
    });
    emit({
      type: "task.started",
      runId,
      timestamp: now(),
      task: verifierTask,
      workerId: worker.workerId,
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
    if (result.status === "success") {
      emit({
        type: "task.completed",
        runId,
        timestamp: now(),
        task: verifierTask,
        workerId: worker.workerId,
        result,
      });
    } else {
      emit({
        type: "task.failed",
        runId,
        timestamp: now(),
        task: verifierTask,
        workerId: worker.workerId,
        error: result.summary,
      });
    }
    if (result.verification) {
      emit({
        type: "verification.completed",
        runId,
        timestamp: now(),
        result: result.verification,
      });
    }
    return result;
  }

  private async runVerification(
    project: ProjectSpace,
    commands: string[],
    workerId: string,
    runId: string,
    emit: OrchestrationEventSink
  ): Promise<VerificationResult> {
    const worker = new VerifierWorker({
      workerId,
      executeCommands: this.executeVerificationCommands,
    });
    const result = await worker.verify(commands, project.root);
    emit({
      type: "verification.completed",
      runId,
      timestamp: now(),
      result,
    });
    return result;
  }

  private async runReviewers(
    project: ProjectSpace,
    tasks: TaskContract[],
    runId: string,
    emit: OrchestrationEventSink
  ): Promise<ReviewResult[]> {
    return Promise.all(
      tasks.map(async (task) => {
        const workspacePath = await this.workspaceManager.createReviewWorkspace(project, task.taskId);
        const worker = new ReviewWorker({
          workerId: `${task.taskId}-worker`,
          modelRunner: this.modelRunner,
        });
        const threadRunId = createThreadRunId(runId, task.taskId);
        const telemetry = this.createTelemetry({
          runId,
          threadRunId,
          taskId: task.taskId,
          workerId: worker.workerId,
          role: "reviewer",
          model: modelForTask(task),
          reasoningEffort: task.reasoningEffort,
          emit,
        });
        emit({
          type: "task.started",
          runId,
          timestamp: now(),
          task,
          workerId: worker.workerId,
          threadRunId,
        });
        const result = await worker.runReview(task, {
          project,
          workspacePath,
          codexOptions: createCodexOptions({
            role: "reviewer",
            project: {
              ...project,
              root: workspacePath,
            },
            taskScope: {
              readablePaths: task.readPaths,
              reportPaths: [".agent-orchestrator/reviews", ".agent-orchestrator/tmp"],
              forbiddenPaths: task.forbiddenPaths,
            },
          }),
          taskContract: task,
          inputFiles: task.readPaths,
          telemetry,
        });
        emit({
          type: "review.completed",
          runId,
          timestamp: now(),
          task,
          result,
        });
        emit({
          type: "task.completed",
          runId,
          timestamp: now(),
          task,
          workerId: worker.workerId,
          threadRunId,
        });
        return result;
      })
    );
  }

  private createTelemetry(input: ModelRunTelemetry): ModelRunTelemetry {
    return input;
  }

  private maxConcurrencyForRole(role: AgentRole): number {
    switch (role) {
      case "component-worker":
        return this.maxSparkWorkers;
      case "layout-worker":
        return this.maxMiniWorkers;
      case "screen-worker":
        return this.maxGpt55Workers;
      case "reviewer":
        return 4;
      case "planner":
      case "verifier":
      case "merge-broker":
        return 1;
    }
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

  private finishResult(
    status: OrchestrationResult["status"],
    dag: TaskDAG,
    taskResults: WorkerResult[],
    mergeResults: MergeResult[],
    verificationResults: VerificationResult[],
    reviewResults: ReviewResult[],
    summary: string,
    eventLog: OrchestrationEvent[]
  ): OrchestrationResult {
    const trace = buildThreadRunTrace(eventLog);
    return {
      status,
      dag,
      taskResults,
      mergeResults,
      verificationResults,
      reviewResults,
      trace,
      modelUsage: summarizeModelUsage(trace),
      summary,
    };
  }
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    this.closed = true;
    let waiter = this.waiters.shift();
    while (waiter) {
      waiter({ value: undefined, done: true });
      waiter = this.waiters.shift();
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.values.length > 0) {
          const value = this.values.shift() as T;
          return Promise.resolve({ value, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}

class PlanReviewCoordinator implements PlanReviewController {
  private pending?: {
    resolve: (decision: PlanReviewDecision) => void;
  };

  waitForDecision(): Promise<PlanReviewDecision> {
    if (this.pending) {
      throw new Error("A plan review decision is already pending.");
    }
    return new Promise<PlanReviewDecision>((resolve) => {
      this.pending = { resolve };
    });
  }

  approve(): void {
    this.resolve({ action: "approve" });
  }

  revise(feedback: string): void {
    const trimmed = feedback.trim();
    if (!trimmed) {
      throw new Error("Plan revision feedback is required.");
    }
    this.resolve({ action: "revise", feedback: trimmed });
  }

  cancel(reason?: string): void {
    this.resolve({ action: "cancel", reason });
  }

  private resolve(decision: PlanReviewDecision): void {
    if (!this.pending) {
      throw new Error("No plan review is currently pending.");
    }
    const pending = this.pending;
    this.pending = undefined;
    pending.resolve(decision);
  }
}

function canRunTogether(left: TaskContract, right: TaskContract): boolean {
  return (
    !left.dependencies.includes(right.taskId) &&
    !right.dependencies.includes(left.taskId) &&
    !hasPathOverlap(left.writePaths, right.writePaths) &&
    !hasPathOverlap(left.writePaths, right.forbiddenPaths) &&
    !hasPathOverlap(right.writePaths, left.forbiddenPaths)
  );
}

function modelForTask(task: TaskContract): string {
  return task.model || task.modelTier || task.role;
}

function getPlannerModelFromRunner(modelRunner: ModelRunner): string | undefined {
  const candidate = modelRunner as { config?: { plannerModel?: string } };
  return candidate.config?.plannerModel;
}

function uniqueCommands(commands: string[]): string[] {
  return [...new Set(commands.map((command) => command.trim()).filter(Boolean))];
}

function createRunId(): string {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function createThreadRunId(runId: string, purpose: string): string {
  const safePurpose = purpose.replace(/[^a-zA-Z0-9_.-]+/g, "-");
  return `${runId}:${safePurpose}:${Math.random().toString(36).slice(2, 8)}`;
}

function now(): string {
  return new Date().toISOString();
}
