import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { groupParallelTasks, validateTaskDAG } from "../dist/index.js";

function makeTask(taskId, overrides = {}) {
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
    ...overrides,
  };
}

function normalDag() {
  const implementation = [
    makeTask("component-a"),
    makeTask("layout", {
      role: "layout-worker",
      model: "layout-model",
      modelTier: "mini",
      reasoningEffort: "medium",
      dependencies: ["component-a"],
      writePaths: ["src/layout.ts"],
    }),
    makeTask("screen", {
      role: "screen-worker",
      model: "screen-model",
      modelTier: "gpt-5.5",
      reasoningEffort: "high",
      dependencies: ["layout"],
      writePaths: ["src/screen.ts"],
    }),
  ];
  const reviewer = makeTask("review", {
    role: "reviewer",
    model: "review-model",
    modelTier: "gpt-5.5",
    reasoningEffort: "high",
    writePaths: [],
    dependencies: implementation.map((task) => task.taskId),
  });
  const tasks = [...implementation, reviewer];
  return {
    dagId: "normal",
    tasks,
    edges: tasks.flatMap((task) =>
      task.dependencies.map((dependency) => ({ from: dependency, to: task.taskId, reason: "test" }))
    ),
  };
}

describe("task dag", () => {
  it("accepts a normal DAG", () => {
    const result = validateTaskDAG(normalDag());
    assert.equal(result.valid, true, result.errors.join("; "));
  });

  it("rejects cycle dependencies", () => {
    const dag = normalDag();
    dag.tasks[0].dependencies = ["screen"];
    const result = validateTaskDAG(dag);
    assert.equal(result.valid, false);
    assert.match(result.errors.join("\n"), /cycle/);
  });

  it("rejects duplicate taskId", () => {
    const dag = normalDag();
    dag.tasks.push({ ...dag.tasks[0] });
    const result = validateTaskDAG(dag);
    assert.equal(result.valid, false);
    assert.match(result.errors.join("\n"), /Duplicate taskId/);
  });

  it("does not group overlapping writePaths in parallel", () => {
    const tasks = [
      makeTask("a", { writePaths: ["src/shared.ts"] }),
      makeTask("b", { writePaths: ["src/shared.ts"] }),
    ];
    const groups = groupParallelTasks(tasks);
    assert.equal(groups.length, 2);
  });
});
