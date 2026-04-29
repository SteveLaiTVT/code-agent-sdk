import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Codex, type RunResult } from "@openai/codex-sdk";
import path from "node:path";
import { AgentOrchestrator, type AgentOrchestratorOptions } from "./agents/orchestrator.js";
import { createCodexClientOptions } from "./common/codex-env.js";
import {
  CodexModelRunnerAdapter,
  type CodexModelRunnerAdapterConfig,
} from "./adapters/codex-model-runner.js";
import type { OrchestrationResult, OrchestrationStream, ProjectSpace } from "./core/types.js";
import { WorkspaceManager } from "./workspace/workspace-manager.js";
import { MergeBroker } from "./merge/merge-broker.js";

const execFileAsync = promisify(execFile);

export interface RunCodingTaskOptions {
  /** Stable id used in traces and reports. Defaults to the repo directory name. */
  projectId?: string;
  /** Concrete model names used by the real Codex-backed planner, workers, and reviewers. */
  modelConfig?: Partial<CodexModelRunnerAdapterConfig>;
  /** Orchestrator controls such as plan review, validation, concurrency, and custom adapters. */
  orchestrator?: Partial<AgentOrchestratorOptions>;
}

export async function test(
  message: string,
  repo: string,
  branch: string,
  options: RunCodingTaskOptions = {}
): Promise<OrchestrationResult> {
  return runCodingTask(message, repo, branch, options);
}

export async function runCodingTask(
  message: string,
  repo: string,
  branch: string,
  options: RunCodingTaskOptions = {}
): Promise<OrchestrationResult> {
  if (options.orchestrator?.planReview?.mode === "manual") {
    throw new Error(
      "Manual plan review requires runCodingTaskStreamed() so the caller can approve, revise, or cancel the plan."
    );
  }
  const { orchestrator, project } = await createCodingTaskContext(repo, branch, options);
  return orchestrator.run(message, project);
}

export async function runCodingTaskStreamed(
  message: string,
  repo: string,
  branch: string,
  options: RunCodingTaskOptions = {}
): Promise<OrchestrationStream> {
  const { orchestrator, project } = await createCodingTaskContext(repo, branch, options);
  return orchestrator.runStreamed(message, project);
}

async function createCodingTaskContext(
  repo: string,
  branch: string,
  options: RunCodingTaskOptions
): Promise<{ orchestrator: AgentOrchestrator; project: ProjectSpace }> {
  await ensureBranch(repo, branch);
  const project: ProjectSpace = {
    projectId: options.projectId ?? path.basename(path.resolve(repo)),
    root: path.resolve(repo),
  };
  const workspaceManager =
    options.orchestrator?.workspaceManager ??
    new WorkspaceManager({ strategy: "git-worktree", keepWorkspaces: true });
  const mergeBroker =
    options.orchestrator?.mergeBroker ?? new MergeBroker({ workspaceManager });
  const orchestrator = new AgentOrchestrator({
    modelRunner:
      options.orchestrator?.modelRunner ??
      new CodexModelRunnerAdapter(options.modelConfig),
    workspaceManager,
    mergeBroker,
    plannerModel: options.modelConfig?.plannerModel,
    executeVerificationCommands: true,
    ...options.orchestrator,
  });
  return { orchestrator, project };
}

export async function runSingleCodexTask(
  message: string,
  repo: string,
  branch: string
): Promise<RunResult> {
  await ensureBranch(repo, branch);
  const codex = new Codex(createCodexClientOptions());
  const thread = codex.startThread({ workingDirectory: repo });
  return thread.run(message);
}

async function ensureBranch(repo: string, branch: string): Promise<void> {
  try {
    await execFileAsync("git", ["-C", repo, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
    });
  } catch {
    throw new Error(`Not a git repository: ${repo}`);
  }
  try {
    await execFileAsync("git", ["-C", repo, "fetch", "--quiet", "origin", branch], {
      encoding: "utf8",
    });
  } catch {
  }
  try {
    await execFileAsync("git", ["-C", repo, "checkout", branch], { encoding: "utf8" });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`git checkout ${branch} in ${repo} failed: ${reason}`);
  }
}

export { Codex, type RunResult, type Thread, type RunStreamedResult } from "@openai/codex-sdk";
export { createCodexClientOptions, loadDotEnv, parseDotEnv } from "./common/codex-env.js";
export * from "./task-session.js";
export * from "./code-agent.js";
export * from "./agents/roles.js";
export * from "./agents/profiles.js";
export * from "./agents/codex-options.js";
export * from "./agents/model-runner.js";
export * from "./agents/worker.js";
export * from "./agents/worker-pool.js";
export * from "./agents/orchestrator.js";
export * from "./adapters/codex-model-runner.js";
export * from "./core/types.js";
export * from "./core/orchestration-stream.js";
export * from "./core/task-dag.js";
export * from "./core/task-contract.js";
export * from "./core/path-safety.js";
export * from "./core/validation.js";
export * from "./workspace/workspace-manager.js";
export * from "./workspace/patch.js";
export * from "./merge/merge-broker.js";
export * from "./review/review-types.js";
export * from "./review/review-aggregator.js";
export * from "./review/review-workers.js";
export * from "./verifier/verifier.js";
