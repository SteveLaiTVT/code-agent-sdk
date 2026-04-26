import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertInsideProject, resolveInsideProject } from "../core/path-safety.js";
import type { PatchApplyResult, ProjectSpace, TaskContract } from "../core/types.js";
import { readMockPatchFile } from "./patch.js";

export interface WorkspaceManagerOptions {
  strategy?: "directory-copy" | "git-worktree" | "mock";
  keepWorkspaces?: boolean;
}

export class WorkspaceManager {
  private readonly strategy: WorkspaceManagerOptions["strategy"];
  private readonly keepWorkspaces: boolean;

  constructor(options: WorkspaceManagerOptions = {}) {
    this.strategy = options.strategy ?? "mock";
    this.keepWorkspaces = options.keepWorkspaces ?? false;
  }

  async createTaskWorkspace(project: ProjectSpace, task: TaskContract): Promise<string> {
    const baseDir = resolveInsideProject(project.root, ".agent-orchestrator/workspaces");
    await mkdir(baseDir, { recursive: true });
    const workspacePath = path.join(
      baseDir,
      `${task.taskId}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    assertInsideProject(project.root, workspacePath);
    await mkdir(workspacePath, { recursive: true });
    await writeFile(
      path.join(workspacePath, "WORKSPACE_STRATEGY.txt"),
      `${this.strategy ?? "mock"}\n`,
      "utf8"
    );
    return workspacePath;
  }

  async cleanupTaskWorkspace(workspacePath: string): Promise<void> {
    if (this.keepWorkspaces) {
      return;
    }
    await rm(workspacePath, { recursive: true, force: true });
  }

  async createReviewWorkspace(project: ProjectSpace, reviewId: string): Promise<string> {
    const baseDir = resolveInsideProject(project.root, ".agent-orchestrator/review-workspaces");
    await mkdir(baseDir, { recursive: true });
    const workspacePath = path.join(
      baseDir,
      `${reviewId}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    assertInsideProject(project.root, workspacePath);
    await mkdir(workspacePath, { recursive: true });
    return workspacePath;
  }

  async generatePatch(taskWorkspace: string, _projectRoot: string, taskId: string): Promise<string> {
    const patchDir = path.join(taskWorkspace, ".agent-orchestrator", "patches");
    const patchPath = path.join(patchDir, `${taskId}.mock-patch.json`);
    await mkdir(patchDir, { recursive: true });
    try {
      await readMockPatchFile(patchPath);
      return patchPath;
    } catch {
      await writeFile(
        patchPath,
        `${JSON.stringify(
          {
            format: "code-agent-sdk.mock-patch.v1",
            taskId,
            changedFiles: [],
            operations: [],
          },
          null,
          2
        )}\n`,
        "utf8"
      );
      return patchPath;
    }
  }

  async applyPatch(project: ProjectSpace, patchPath: string): Promise<PatchApplyResult> {
    try {
      const patch = await readMockPatchFile(patchPath);
      const changedFiles: string[] = [];

      for (const operation of patch.operations) {
        if (operation.type !== "write") {
          throw new Error(`Unsupported patch operation: ${operation.type}`);
        }
        const targetPath = resolveInsideProject(project.root, operation.path);
        await mkdir(path.dirname(targetPath), { recursive: true });
        await writeFile(targetPath, operation.content, "utf8");
        changedFiles.push(operation.path);
      }

      return {
        status: "applied",
        patchPath,
        changedFiles,
        summary:
          changedFiles.length > 0
            ? `Applied ${changedFiles.length} file(s) from mock patch.`
            : "Applied empty mock patch.",
        errors: [],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "failed",
        patchPath,
        changedFiles: [],
        summary: `Failed to apply patch in ${os.platform()} workspace.`,
        errors: [message],
      };
    }
  }
}
