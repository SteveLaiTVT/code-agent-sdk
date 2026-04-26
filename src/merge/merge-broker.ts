import { getAnyPatchChangedFiles, readMockPatchFile } from "../workspace/patch.js";
import { WorkspaceManager } from "../workspace/workspace-manager.js";
import { hasPathOverlap, isPathWithinAnyPath } from "../core/path-safety.js";
import type { MergeResult, ProjectSpace, TaskContract, ValidationResult } from "../core/types.js";
import { createValidationResult } from "../core/validation.js";
import type { WorkerResult } from "../agents/worker.js";

export interface MergeBrokerOptions {
  workspaceManager?: WorkspaceManager;
}

export interface TaskWorkerResult {
  task: TaskContract;
  result: WorkerResult;
}

export class MergeBroker {
  private readonly workspaceManager: WorkspaceManager;

  constructor(options: MergeBrokerOptions = {}) {
    this.workspaceManager = options.workspaceManager ?? new WorkspaceManager();
  }

  async validatePatchAgainstTask(patchPath: string, task: TaskContract): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      let patchTaskId: string | undefined;
      let operationPaths: string[] = [];
      let changedFiles: string[];

      try {
        const patch = await readMockPatchFile(patchPath);
        patchTaskId = patch.taskId;
        operationPaths = patch.operations.map((operation) => operation.path);
        changedFiles = patch.changedFiles.length > 0 ? patch.changedFiles : operationPaths;
      } catch {
        changedFiles = await getAnyPatchChangedFiles(patchPath);
      }

      if (patchTaskId && patchTaskId !== task.taskId) {
        errors.push(`Patch taskId ${patchTaskId} does not match task ${task.taskId}`);
      }

      for (const changedFile of changedFiles) {
        if (hasPathOverlap([changedFile], task.forbiddenPaths)) {
          errors.push(`Patch for ${task.taskId} modifies forbidden path: ${changedFile}`);
        }
        if (!isPathWithinAnyPath(changedFile, task.writePaths)) {
          errors.push(`Patch for ${task.taskId} modifies unauthorized path: ${changedFile}`);
        }
      }

      for (const operationPath of operationPaths) {
        if (!changedFiles.includes(operationPath)) {
          warnings.push(`Patch operation path ${operationPath} is not listed in changedFiles`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`Unable to validate patch ${patchPath}: ${message}`);
    }

    return createValidationResult(errors, warnings);
  }

  async applyWorkerResult(
    project: ProjectSpace,
    task: TaskContract,
    result: WorkerResult
  ): Promise<MergeResult> {
    if (result.status !== "success") {
      return {
        taskId: task.taskId,
        status: result.status === "needs_review" ? "needs_changes" : "failed",
        changedFiles: result.changedFiles,
        patchPath: result.patchPath,
        summary: `Worker result for ${task.taskId} was not successful: ${result.status}`,
        validation: createValidationResult([`Worker status was ${result.status}`]),
        errors: [`Worker status was ${result.status}`],
      };
    }

    if (!result.patchPath) {
      return {
        taskId: task.taskId,
        status: "failed",
        changedFiles: result.changedFiles,
        summary: `Worker result for ${task.taskId} did not include a patchPath.`,
        validation: createValidationResult(["Missing patchPath"]),
        errors: ["Missing patchPath"],
      };
    }

    const changedFileErrors = result.changedFiles.flatMap((changedFile) => {
      const errors: string[] = [];
      if (hasPathOverlap([changedFile], task.forbiddenPaths)) {
        errors.push(`Changed file is forbidden: ${changedFile}`);
      }
      if (!isPathWithinAnyPath(changedFile, task.writePaths)) {
        errors.push(`Changed file is outside writePaths: ${changedFile}`);
      }
      return errors;
    });

    const patchValidation = await this.validatePatchAgainstTask(result.patchPath, task);
    const validation = createValidationResult(
      [...changedFileErrors, ...patchValidation.errors],
      patchValidation.warnings,
      patchValidation.issues ?? []
    );

    if (!validation.valid) {
      return {
        taskId: task.taskId,
        status: "needs_changes",
        changedFiles: result.changedFiles,
        patchPath: result.patchPath,
        summary: `Patch for ${task.taskId} failed merge-broker validation.`,
        validation,
        errors: validation.errors,
      };
    }

    const applyResult = await this.workspaceManager.applyPatch(project, result.patchPath);
    if (applyResult.status !== "applied") {
      return {
        taskId: task.taskId,
        status: "failed",
        changedFiles: applyResult.changedFiles,
        patchPath: result.patchPath,
        summary: applyResult.summary,
        validation,
        errors: applyResult.errors,
      };
    }

    return {
      taskId: task.taskId,
      status: "merged",
      changedFiles: applyResult.changedFiles,
      patchPath: result.patchPath,
      summary: applyResult.summary,
      validation,
      errors: [],
    };
  }

  async mergeMany(project: ProjectSpace, taskResults: TaskWorkerResult[]): Promise<MergeResult[]> {
    const merged = new Set<string>();
    const pending = [...taskResults];
    const results: MergeResult[] = [];

    while (pending.length > 0) {
      const index = pending.findIndex(({ task }) =>
        task.dependencies.every((dependency) => merged.has(dependency) || !pending.some((item) => item.task.taskId === dependency))
      );

      if (index === -1) {
        const blocked = pending.map(({ task }) => task.taskId).join(", ");
        for (const item of pending) {
          results.push({
            taskId: item.task.taskId,
            status: "failed",
            changedFiles: item.result.changedFiles,
            patchPath: item.result.patchPath,
            summary: `Could not merge due to unresolved dependency order: ${blocked}`,
            validation: createValidationResult([`Unresolved dependency order: ${blocked}`]),
            errors: [`Unresolved dependency order: ${blocked}`],
          });
        }
        break;
      }

      const [next] = pending.splice(index, 1);
      const mergeResult = await this.applyWorkerResult(project, next.task, next.result);
      results.push(mergeResult);
      if (mergeResult.status === "merged") {
        merged.add(next.task.taskId);
      }
    }

    return results;
  }
}
