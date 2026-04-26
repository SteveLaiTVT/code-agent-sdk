import { AgentOrchestrator } from "../agents/orchestrator.js";
import type { ProjectSpace } from "../core/types.js";

export async function runDemo(root = process.cwd()) {
  const project: ProjectSpace = {
    projectId: "code-agent-sdk-demo",
    root,
  };
  const requirement =
    "实现一个任务卡片系统，包括 StatusBadge、TaskCard、TaskCardGrid layout 和 TaskBoardScreen。";

  const orchestrator = new AgentOrchestrator({
    maxSparkWorkers: 4,
    maxMiniWorkers: 2,
    maxGpt55Workers: 1,
    executeVerificationCommands: false,
  });

  return orchestrator.run(requirement, project);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runDemo();
  console.log(
    JSON.stringify(
      {
        status: result.status,
        summary: result.summary,
        dagId: result.dag.dagId,
        taskCount: result.dag.tasks.length,
        taskResults: result.taskResults.map((taskResult) => ({
          taskId: taskResult.taskId,
          workerId: taskResult.workerId,
          status: taskResult.status,
          changedFiles: taskResult.changedFiles,
          patchPath: taskResult.patchPath,
        })),
        mergeResults: result.mergeResults.map((mergeResult) => ({
          taskId: mergeResult.taskId,
          status: mergeResult.status,
          changedFiles: mergeResult.changedFiles,
          errors: mergeResult.errors,
        })),
        verificationResults: result.verificationResults.map((verification) => ({
          status: verification.status,
          summary: verification.summary,
          commands: verification.commands.map((command) => ({
            command: command.command,
            status: command.status,
          })),
        })),
        reviewResults: result.reviewResults.map((review) => ({
          reviewerId: review.reviewerId,
          reviewType: review.reviewType,
          status: review.status,
          summary: review.summary,
        })),
      },
      null,
      2
    )
  );
}
