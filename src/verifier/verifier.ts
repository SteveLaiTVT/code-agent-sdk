import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { AgentWorker, WorkerContext, WorkerResult } from "../agents/worker.js";
import type { CommandRunResult, TaskContract, VerificationResult } from "../core/types.js";

const execAsync = promisify(exec);

export interface VerifierWorkerOptions {
  workerId?: string;
  executeCommands?: boolean;
  timeoutMs?: number;
}

export class VerifierWorker implements AgentWorker {
  readonly workerId: string;
  readonly role = "verifier" as const;
  private readonly executeCommands: boolean;
  private readonly timeoutMs: number;

  constructor(options: VerifierWorkerOptions = {}) {
    this.workerId = options.workerId ?? `verifier-${Math.random().toString(36).slice(2)}`;
    this.executeCommands = options.executeCommands ?? false;
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async verify(commands: string[], cwd: string): Promise<VerificationResult> {
    if (commands.length === 0) {
      return {
        status: "skipped",
        commands: [],
        summary: "No verification commands configured.",
      };
    }

    const commandResults: CommandRunResult[] = [];
    for (const command of commands) {
      if (!this.executeCommands) {
        commandResults.push({
          command,
          status: "passed",
          outputSummary: "Passed by mock verifier.",
        });
        continue;
      }

      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd,
          timeout: this.timeoutMs,
          maxBuffer: 1024 * 1024,
        });
        commandResults.push({
          command,
          status: "passed",
          outputSummary: `${stdout}${stderr}`.trim().slice(0, 2000) || "Command passed.",
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        commandResults.push({
          command,
          status: "failed",
          outputSummary: message.slice(0, 2000),
        });
      }
    }

    const hasFailedCommand = commandResults.some((result) => result.status === "failed");
    return {
      status: hasFailedCommand ? "failed" : "passed",
      commands: commandResults,
      summary: hasFailedCommand
        ? "One or more verification commands failed."
        : "Verification commands passed.",
    };
  }

  async run(task: TaskContract, context: WorkerContext): Promise<WorkerResult> {
    const verification = await this.verify(task.verificationCommands, context.project.root);
    return {
      taskId: task.taskId,
      workerId: this.workerId,
      threadRunId: context.telemetry?.threadRunId,
      status: verification.status === "failed" ? "failed" : "success",
      changedFiles: [],
      logs: verification.commands.map(
        (command) => `${command.status}: ${command.command} - ${command.outputSummary}`
      ),
      summary: verification.summary,
      verification,
    };
  }
}
