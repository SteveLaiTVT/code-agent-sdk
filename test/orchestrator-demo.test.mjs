import { strict as assert } from "node:assert";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { runDemo } from "../dist/examples/run-demo.js";
import { SparkWorkerPool } from "../dist/index.js";

function task(taskId) {
  return {
    taskId,
    title: taskId,
    role: "component-worker",
    model: "test-model",
    modelTier: "spark",
    reasoningEffort: "low",
    objective: taskId,
    readPaths: ["src"],
    writePaths: [`src/${taskId}.ts`],
    forbiddenPaths: [".env", ".git", "node_modules"],
    dependencies: [],
    acceptanceCriteria: [],
    verificationCommands: [],
    riskLevel: "low",
  };
}

describe("orchestrator demo", () => {
  it("runs the full mock orchestration flow", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orchestrator-demo-"));
    const result = await runDemo(root);
    assert.equal(result.status, "pass");
    assert.equal(typeof result.summary, "string");
    assert.ok(result.dag.tasks.length >= 9);
    assert.ok(result.taskResults.some((item) => item.workerId.startsWith("spark-worker-")));
    assert.ok(result.mergeResults.length >= 4);
    assert.equal(result.reviewResults.length, 4);
  });

  it("Spark worker pool runs mock workers in parallel", async () => {
    let active = 0;
    let maxActive = 0;
    const pool = new SparkWorkerPool(2);
    const tasks = [task("a"), task("b")];
    const results = await pool.run(
      tasks,
      (_task, index) => ({
        workerId: `mock-spark-${index}`,
        role: "component-worker",
        async run(currentTask) {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 30));
          active -= 1;
          return {
            taskId: currentTask.taskId,
            workerId: `mock-spark-${index}`,
            status: "success",
            changedFiles: currentTask.writePaths,
            logs: [],
            summary: "ok",
          };
        },
      }),
      async (currentTask) => ({
        project: { projectId: "p", root: await mkdtemp(path.join(os.tmpdir(), "spark-pool-")) },
        workspacePath: await mkdtemp(path.join(os.tmpdir(), "spark-workspace-")),
        codexOptions: {},
        taskContract: currentTask,
      })
    );
    assert.equal(results.length, 2);
    assert.equal(maxActive, 2);
  });
});
