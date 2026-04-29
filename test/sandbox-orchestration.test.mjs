import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { AgentOrchestrator, WorkspaceManager } from "../dist/index.js";

function implementationTask() {
  return {
    taskId: "sandboxed-worker",
    title: "Sandboxed worker",
    role: "component-worker",
    model: "test-model",
    modelTier: "spark",
    reasoningEffort: "low",
    objective: "Write through a workspace-scoped patch.",
    readPaths: ["src"],
    writePaths: ["src/sandboxed.ts"],
    forbiddenPaths: [".env", ".git", "node_modules"],
    dependencies: [],
    acceptanceCriteria: ["The worker can only write the declared path."],
    validationTools: [],
    verificationCommands: [],
    riskLevel: "low",
    expectedOutputs: [],
    notes: [],
  };
}

async function project() {
  const root = await mkdtemp(path.join(os.tmpdir(), "sandbox-orchestration-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  return {
    projectId: "sandbox-orchestration",
    root,
  };
}

async function writeMockPatch(workspacePath, task, content) {
  const patchDir = path.join(workspacePath, ".agent-orchestrator", "patches");
  await mkdir(patchDir, { recursive: true });
  const patchPath = path.join(patchDir, `${task.taskId}.mock-patch.json`);
  await writeFile(
    patchPath,
    `${JSON.stringify(
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
    )}\n`,
    "utf8"
  );
  return patchPath;
}

describe("orchestrator sandbox policy", () => {
  it("runs worker patches from task workspace through validation and merge gate", async () => {
    const task = implementationTask();
    let workerSawWorkspacePolicy = false;

    class SandboxRecordingRunner {
      async runPlanner(_requirement, context = {}) {
        assert.equal(context.codexOptions.config.sandbox_mode, "read-only");
        assert.equal(context.codexOptions.config.sandbox_workspace_write.network_access, false);
        return {
          dagId: "sandbox-dag",
          tasks: [task],
          edges: [],
        };
      }

      async runWorker(input) {
        assert.ok(
          input.workspacePath.includes(`${path.sep}.agent-orchestrator${path.sep}workspaces${path.sep}`)
        );
        assert.deepEqual(input.codexOptions.config.sandbox_workspace_write.writable_roots, [
          path.join(input.workspacePath, task.writePaths[0]),
        ]);
        assert.equal(input.codexOptions.config.sandbox_workspace_write.network_access, false);
        workerSawWorkspacePolicy = true;
        return {
          summary: "Wrote a sandboxed file.",
          changedFiles: task.writePaths,
          logs: [],
          patchPath: await writeMockPatch(
            input.workspacePath,
            task,
            "export const sandboxed = true;\n"
          ),
        };
      }

      async runReviewer() {
        throw new Error("Reviewer is not part of this focused sandbox test.");
      }
    }

    const targetProject = await project();
    const orchestrator = new AgentOrchestrator({
      modelRunner: new SandboxRecordingRunner(),
      workspaceManager: new WorkspaceManager({ strategy: "mock" }),
      executeVerificationCommands: false,
    });

    const result = await orchestrator.run("write through sandbox", targetProject);

    assert.equal(result.status, "pass");
    assert.equal(workerSawWorkspacePolicy, true);
    assert.equal(result.mergeResults[0].status, "merged");
    assert.equal(
      await readFile(path.join(targetProject.root, task.writePaths[0]), "utf8"),
      "export const sandboxed = true;\n"
    );
  });
});
