import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { AgentOrchestrator, WorkspaceManager } from "../dist/index.js";

function implementationTask() {
  return {
    taskId: "write-bad-js",
    title: "Write invalid JavaScript",
    role: "component-worker",
    model: "test-model",
    modelTier: "spark",
    reasoningEffort: "low",
    objective: "Write a JavaScript module with a syntax error.",
    readPaths: ["src", "package.json"],
    writePaths: ["src/bad.mjs"],
    forbiddenPaths: [".env", ".git", "node_modules"],
    dependencies: [],
    acceptanceCriteria: ["The SDK should reject syntax-invalid output before merge."],
    validationTools: ["npm"],
    verificationCommands: ["npm run build"],
    riskLevel: "low",
    expectedOutputs: [],
    notes: [],
  };
}

async function project() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pre-merge-validation-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        type: "module",
        scripts: {
          build: "node --check src/bad.mjs",
        },
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
  return { projectId: "pre-merge-validation", root };
}

async function writeMockPatch(workspacePath, task, content) {
  const patchDir = path.join(workspacePath, ".agent-orchestrator", "patches");
  await mkdir(patchDir, { recursive: true });
  const patchPath = path.join(patchDir, `${task.taskId}.mock-patch.json`);
  await writeFile(
    patchPath,
    JSON.stringify(
      {
        format: "code-agent-sdk.mock-patch.v1",
        taskId: task.taskId,
        changedFiles: task.writePaths,
        operations: task.writePaths.map((writePath) => ({
          type: "write",
          path: writePath,
          content,
        })),
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
  return patchPath;
}

describe("pre-merge validation", () => {
  it("rejects an implementation patch before it is merged when validation fails", async () => {
    const task = implementationTask();
    class BadPatchRunner {
      async runPlanner() {
        return {
          dagId: "bad-js-dag",
          tasks: [task],
          edges: [],
        };
      }

      async runWorker(input) {
        return {
          summary: "Wrote invalid JavaScript.",
          changedFiles: task.writePaths,
          logs: [],
          patchPath: await writeMockPatch(input.workspacePath, task, "export const broken = ;\n"),
        };
      }

      async runReviewer() {
        throw new Error("Reviewer should not run after pre-merge validation failure.");
      }
    }

    const targetProject = await project();
    const orchestrator = new AgentOrchestrator({
      modelRunner: new BadPatchRunner(),
      workspaceManager: new WorkspaceManager({ strategy: "mock" }),
      executeVerificationCommands: true,
    });
    const stream = orchestrator.runStreamed("write invalid js", targetProject);
    const events = [];
    for await (const event of stream.events) {
      events.push(event);
    }
    const result = await stream.result;

    assert.equal(result.status, "failed");
    assert.match(result.summary, /Pre-merge validation failed/);
    assert.equal(result.mergeResults.length, 0);
    assert.equal(result.taskResults[0].status, "failed");
    assert.equal(result.taskResults[0].verification.status, "failed");
    assert.ok(events.some((event) => event.type === "task.validation.completed"));
    await assert.rejects(readFile(path.join(targetProject.root, task.writePaths[0]), "utf8"));
  });

  it("does not replay task-level verification after merge when pre-merge validation is enabled", async () => {
    const task = {
      ...implementationTask(),
      taskId: "write-good-js",
      title: "Write valid JavaScript",
      objective: "Write a valid JavaScript module.",
      writePaths: ["src/good.mjs"],
      acceptanceCriteria: ["The SDK should validate once before merge and not replay the same task command after merge."],
    };

    class GoodPatchRunner {
      async runPlanner() {
        return {
          dagId: "good-js-dag",
          tasks: [task],
          edges: [],
        };
      }

      async runWorker(input) {
        return {
          summary: "Wrote valid JavaScript.",
          changedFiles: task.writePaths,
          logs: [],
          patchPath: await writeMockPatch(input.workspacePath, task, "export const working = 1;\n"),
        };
      }

      async runReviewer() {
        throw new Error("Reviewer should not run for this focused pre-merge validation test.");
      }
    }

    const targetProject = await project();
    await writeFile(
      path.join(targetProject.root, "package.json"),
      JSON.stringify(
        {
          type: "module",
          scripts: {
            build: "node --check src/good.mjs",
          },
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    const orchestrator = new AgentOrchestrator({
      modelRunner: new GoodPatchRunner(),
      workspaceManager: new WorkspaceManager({ strategy: "mock" }),
      executeVerificationCommands: true,
    });

    const result = await orchestrator.run("write valid js", targetProject);

    assert.equal(result.status, "pass");
    assert.equal(result.taskResults[0].verification.status, "passed");
    assert.equal(result.verificationResults.length, 0);
    assert.equal(
      await readFile(path.join(targetProject.root, task.writePaths[0]), "utf8"),
      "export const working = 1;\n"
    );
  });
});
