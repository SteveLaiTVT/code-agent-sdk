import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { assertInsideProject, resolveInsideProject } from "../core/path-safety.js";
import type { PatchApplyResult, ProjectSpace, TaskContract } from "../core/types.js";
import { getAnyPatchChangedFiles, readMockPatchFile } from "./patch.js";

const execFileAsync = promisify(execFile);

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
    if (this.strategy === "git-worktree") {
      await execFileAsync("git", ["-C", project.root, "worktree", "add", "--detach", workspacePath, "HEAD"], {
        encoding: "utf8",
      });
      return workspacePath;
    }
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
    if (this.strategy === "git-worktree") {
      const rootMarker = `${path.sep}.agent-orchestrator${path.sep}workspaces${path.sep}`;
      if (workspacePath.includes(rootMarker)) {
        const projectRoot = workspacePath.slice(0, workspacePath.indexOf(rootMarker));
        await execFileAsync("git", ["-C", projectRoot, "worktree", "remove", "--force", workspacePath], {
          encoding: "utf8",
        }).catch(async () => {
          await rm(workspacePath, { recursive: true, force: true });
        });
      }
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
    await copyProjectSnapshot(project.root, workspacePath);
    await execFileAsync("git", ["-C", workspacePath, "init", "-b", "main"], { encoding: "utf8" });
    await execFileAsync("git", ["-C", workspacePath, "add", "."], { encoding: "utf8" });
    await execFileAsync("git", ["-C", workspacePath, "commit", "-m", "review snapshot"], {
      encoding: "utf8",
    }).catch(() => undefined);
    return workspacePath;
  }

  async generatePatch(taskWorkspace: string, _projectRoot: string, taskId: string): Promise<string> {
    const patchDir = path.join(taskWorkspace, ".agent-orchestrator", "patches");
    const patchPath = path.join(patchDir, `${taskId}.mock-patch.json`);
    await mkdir(patchDir, { recursive: true });
    if (this.strategy === "git-worktree") {
      await execFileAsync("git", ["-C", taskWorkspace, "add", "-N", "."], { encoding: "utf8" }).catch(() => undefined);
      const { stdout } = await execFileAsync("git", ["-C", taskWorkspace, "diff", "--binary", "HEAD"], {
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 20,
      });
      const realPatchPath = path.join(patchDir, `${taskId}.patch`);
      await writeFile(realPatchPath, stdout, "utf8");
      return realPatchPath;
    }
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
      try {
        const changedFiles = await getAnyPatchChangedFiles(patchPath);
        if (changedFiles.length === 0) {
          return {
            status: "applied",
            patchPath,
            changedFiles: [],
            summary: "Patch had no file changes.",
            errors: [],
          };
        }
        await execFileAsync("git", ["-C", project.root, "apply", "--whitespace=nowarn", patchPath], {
          encoding: "utf8",
          maxBuffer: 1024 * 1024 * 20,
        });
        return {
          status: "applied",
          patchPath,
          changedFiles,
          summary: `Applied ${changedFiles.length} file(s) from git patch.`,
          errors: [],
        };
      } catch (realPatchError) {
        const realPatchMessage =
          realPatchError instanceof Error ? realPatchError.message : String(realPatchError);
        const mockPatchMessage = error instanceof Error ? error.message : String(error);
        return {
          status: "failed",
          patchPath,
          changedFiles: [],
          summary: `Failed to apply patch in ${os.platform()} workspace.`,
          errors: [mockPatchMessage, realPatchMessage],
        };
      }
    }
  }
}

async function copyProjectSnapshot(projectRoot: string, workspacePath: string): Promise<void> {
  const ignored = new Set([
    ".git",
    ".agent-orchestrator",
    "node_modules",
    "dist",
    "build",
    ".next",
    "coverage",
  ]);
  const entries = await readdir(projectRoot, { withFileTypes: true });

  for (const entry of entries) {
    if (ignored.has(entry.name)) {
      continue;
    }
    const from = path.join(projectRoot, entry.name);
    const to = path.join(workspacePath, entry.name);
    await cp(from, to, {
      recursive: true,
      filter: (source) => {
        const relative = path.relative(projectRoot, source);
        return !relative.split(path.sep).some((segment) => ignored.has(segment));
      },
    });
  }
}
