import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { CodexModelRunnerAdapter, createCodexOptions } from "../dist/index.js";

const execFileAsync = promisify(execFile);

function task(overrides = {}) {
  return {
    taskId: "adapter-task",
    title: "Adapter task",
    role: "component-worker",
    model: "adapter-model",
    modelTier: "spark",
    reasoningEffort: "low",
    objective: "Exercise adapter sandbox policy.",
    readPaths: ["src"],
    writePaths: ["src/adapter-task.ts"],
    forbiddenPaths: [".env", ".git", "node_modules"],
    dependencies: [],
    acceptanceCriteria: [],
    validationTools: [],
    verificationCommands: [],
    riskLevel: "low",
    expectedOutputs: [],
    notes: [],
    ...overrides,
  };
}

function reviewResult() {
  return {
    reviewerId: "adapter-reviewer",
    reviewType: "security",
    status: "pass",
    summary: "pass",
    blockingIssues: [],
    nonBlockingIssues: [],
    commandsRun: [],
    suggestedFixTasks: [],
  };
}

function runtimeFor(finalResponse) {
  const records = {
    clientOptions: [],
    threadOptions: [],
  };
  return {
    records,
    runtime: {
      createCodex(options) {
        records.clientOptions.push(options);
        return {
          startThread(threadOptions) {
            records.threadOptions.push(threadOptions);
            return {
              async runStreamed() {
                return {
                  events: streamResponse(finalResponse),
                };
              },
            };
          },
        };
      },
    },
  };
}

async function* streamResponse(finalResponse) {
  yield {
    type: "thread.started",
    thread_id: "adapter-thread",
  };
  yield {
    type: "item.completed",
    item: {
      id: "adapter-message",
      type: "agent_message",
      text: finalResponse,
    },
  };
  yield {
    type: "turn.completed",
    usage: {
      input_tokens: 1,
      cached_input_tokens: 0,
      output_tokens: 1,
      reasoning_output_tokens: 0,
    },
  };
}

async function gitWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-adapter-workspace-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "index.ts"), "export const seed = 1;\n", "utf8");
  await execFileAsync("git", ["-C", root, "init", "-b", "main"]);
  await execFileAsync("git", ["-C", root, "add", "."]);
  await execFileAsync("git", ["-C", root, "commit", "-m", "init"], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "code-agent-sdk-test",
      GIT_AUTHOR_EMAIL: "code-agent-sdk@example.com",
      GIT_COMMITTER_NAME: "code-agent-sdk-test",
      GIT_COMMITTER_EMAIL: "code-agent-sdk@example.com",
    },
  });
  return root;
}

describe("CodexModelRunnerAdapter sandbox policy", () => {
  it("starts planner threads with the orchestrator-provided read-only policy", async () => {
    const project = {
      projectId: "adapter-planner",
      root: await mkdtemp(path.join(os.tmpdir(), "codex-adapter-planner-")),
    };
    const dag = {
      dagId: "adapter-dag",
      tasks: [],
      edges: [],
    };
    const { records, runtime } = runtimeFor(JSON.stringify(dag));
    const adapter = new CodexModelRunnerAdapter({}, runtime);
    const codexOptions = createCodexOptions({ role: "planner", project });

    const result = await adapter.runPlanner("plan", { project, codexOptions });

    assert.equal(result.dagId, "adapter-dag");
    assert.equal(records.threadOptions[0].sandboxMode, "read-only");
    assert.equal(records.threadOptions[0].networkAccessEnabled, false);
    assert.equal(records.threadOptions[0].webSearchEnabled, true);
    assert.equal(records.threadOptions[0].workingDirectory, project.root);
    assert.deepEqual(
      records.clientOptions[0].config.sandbox_workspace_write.writable_roots,
      []
    );
  });

  it("uses worker sandbox, network, and writable roots from codexOptions", async () => {
    const workspacePath = await gitWorkspace();
    const currentTask = task();
    const { records, runtime } = runtimeFor("worker complete");
    const adapter = new CodexModelRunnerAdapter({}, runtime);
    const codexOptions = createCodexOptions({
      role: "component-worker",
      project: { projectId: "adapter-worker", root: workspacePath },
      taskScope: {
        writablePaths: currentTask.writePaths,
        forbiddenPaths: currentTask.forbiddenPaths,
        network: {
          shellNetwork: true,
          webSearch: true,
        },
      },
    });

    await adapter.runWorker({
      task: currentTask,
      workspacePath,
      codexOptions,
    });

    assert.equal(records.threadOptions[0].sandboxMode, "workspace-write");
    assert.equal(records.threadOptions[0].networkAccessEnabled, true);
    assert.equal(records.threadOptions[0].webSearchEnabled, true);
    assert.equal(records.threadOptions[0].approvalPolicy, "never");
    assert.equal(records.threadOptions[0].workingDirectory, workspacePath);
    assert.deepEqual(records.clientOptions[0].config.sandbox_workspace_write.writable_roots, [
      path.join(workspacePath, "src/adapter-task.ts"),
    ]);
  });

  it("uses reviewer report-path policy instead of hardcoded thread permissions", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "codex-adapter-reviewer-"));
    const currentTask = task({
      taskId: "security-review",
      role: "reviewer",
      model: "review-model",
      modelTier: "gpt-5.5",
      reasoningEffort: "xhigh",
      writePaths: [],
      dependencies: ["adapter-task"],
      notes: ["reviewType:security"],
    });
    const { records, runtime } = runtimeFor(JSON.stringify(reviewResult()));
    const adapter = new CodexModelRunnerAdapter({}, runtime);
    const codexOptions = createCodexOptions({
      role: "reviewer",
      project: { projectId: "adapter-reviewer", root: workspacePath },
      taskScope: {
        readablePaths: currentTask.readPaths,
        reportPaths: [".agent-orchestrator/reviews"],
        forbiddenPaths: currentTask.forbiddenPaths,
        network: {
          shellNetwork: true,
        },
      },
    });

    const result = await adapter.runReviewer({
      task: currentTask,
      reviewType: "security",
      workspacePath,
      codexOptions,
    });

    assert.equal(result.status, "pass");
    assert.equal(records.threadOptions[0].sandboxMode, "workspace-write");
    assert.equal(records.threadOptions[0].networkAccessEnabled, true);
    assert.equal(records.threadOptions[0].webSearchEnabled, true);
    assert.equal(records.threadOptions[0].modelReasoningEffort, "xhigh");
    assert.deepEqual(records.clientOptions[0].config.sandbox_workspace_write.writable_roots, [
      path.join(workspacePath, ".agent-orchestrator/reviews"),
    ]);
  });
});
