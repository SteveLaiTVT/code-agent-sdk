import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Codex, type RunResult } from "@openai/codex-sdk";

const execFileAsync = promisify(execFile);

export async function test(
  message: string,
  repo: string,
  branch: string
): Promise<RunResult> {
  await ensureBranch(repo, branch);
  const codex = new Codex();
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
export * from "./agents/roles.js";
export * from "./agents/profiles.js";
export * from "./agents/codex-options.js";
export * from "./agents/model-runner.js";
export * from "./agents/worker.js";
export * from "./agents/worker-pool.js";
export * from "./agents/orchestrator.js";
export * from "./adapters/codex-model-runner.js";
export * from "./core/types.js";
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
