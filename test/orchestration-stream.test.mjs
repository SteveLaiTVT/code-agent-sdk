import { strict as assert } from "node:assert";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  AgentOrchestrator,
  MockModelRunner,
  WorkspaceManager,
  collectOrchestrationStream,
  summarizeModelUsage,
} from "../dist/index.js";

function componentTask(taskId, model) {
  return {
    taskId,
    title: taskId,
    role: "component-worker",
    model,
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

async function project() {
  return {
    projectId: "stream-test",
    root: await mkdtemp(path.join(os.tmpdir(), "orchestration-stream-")),
  };
}

describe("orchestration stream", () => {
  it("emits thread events and returns a replayable trace", async () => {
    const orchestrator = new AgentOrchestrator({
      modelRunner: new MockModelRunner(),
      workspaceManager: new WorkspaceManager({ strategy: "mock" }),
      executeVerificationCommands: false,
    });
    const stream = orchestrator.runStreamed("demo stream", await project());
    const events = [];

    for await (const event of stream.events) {
      events.push(event);
    }
    const result = await stream.result;

    assert.equal(result.status, "pass");
    assert.ok(events.some((event) => event.type === "run.started"));
    assert.ok(events.some((event) => event.type === "run.completed"));

    const threadEvents = events.filter((event) => event.type === "thread.event");
    assert.ok(threadEvents.length > 0);
    assert.ok(new Set(threadEvents.map((event) => event.threadRunId)).size >= 5);
    assert.ok(threadEvents.some((event) => event.sdkEvent.type === "item.completed"));
    assert.ok(result.trace.every((trace) => trace.events.length > 0));
    assert.ok(result.modelUsage.byModel["gpt-5.3-codex-spark"].threadCount >= 2);
  });

  it("collects the final result from an async event stream", async () => {
    const orchestrator = new AgentOrchestrator({
      modelRunner: new MockModelRunner(),
      workspaceManager: new WorkspaceManager({ strategy: "mock" }),
      executeVerificationCommands: false,
    });
    const stream = orchestrator.runStreamed("collect stream", await project());
    const collected = await collectOrchestrationStream(stream.events);
    const result = await stream.result;

    assert.equal(collected.status, result.status);
    assert.equal(collected.trace.length, result.trace.length);
    assert.equal(collected.modelUsage.totals.turnCount, result.modelUsage.totals.turnCount);
  });

  it("aggregates token usage by concrete model", () => {
    const summary = summarizeModelUsage([
      {
        runId: "run",
        threadRunId: "run:a",
        role: "component-worker",
        model: "alpha-model",
        status: "completed",
        startedAt: "2026-04-26T00:00:00.000Z",
        events: [
          {
            type: "turn.completed",
            usage: {
              input_tokens: 10,
              cached_input_tokens: 2,
              output_tokens: 5,
              reasoning_output_tokens: 1,
            },
          },
        ],
      },
      {
        runId: "run",
        threadRunId: "run:b",
        role: "layout-worker",
        model: "alpha-model",
        status: "completed",
        startedAt: "2026-04-26T00:00:01.000Z",
        events: [
          {
            type: "turn.completed",
            usage: {
              input_tokens: 4,
              cached_input_tokens: 1,
              output_tokens: 3,
              reasoning_output_tokens: 2,
            },
          },
        ],
      },
      {
        runId: "run",
        threadRunId: "run:c",
        role: "screen-worker",
        model: "beta-model",
        status: "completed",
        startedAt: "2026-04-26T00:00:02.000Z",
        events: [
          {
            type: "turn.completed",
            usage: {
              input_tokens: 7,
              cached_input_tokens: 0,
              output_tokens: 9,
              reasoning_output_tokens: 3,
            },
          },
        ],
      },
    ]);

    assert.equal(summary.byModel["alpha-model"].threadCount, 2);
    assert.equal(summary.byModel["alpha-model"].turnCount, 2);
    assert.equal(summary.byModel["alpha-model"].inputTokens, 14);
    assert.equal(summary.byModel["beta-model"].outputTokens, 9);
    assert.equal(summary.totals.reasoningOutputTokens, 6);
  });

  it("runs worker tasks with the concrete model selected by the planner", async () => {
    const seenModels = [];
    class RecordingModelRunner extends MockModelRunner {
      async runPlanner() {
        const tasks = [componentTask("a", "alpha-model"), componentTask("b", "beta-model")];
        return {
          dagId: "model-selection",
          tasks,
          edges: [],
        };
      }

      async runWorker(input) {
        seenModels.push(input.task.model);
        return super.runWorker(input);
      }
    }

    const orchestrator = new AgentOrchestrator({
      modelRunner: new RecordingModelRunner(),
      workspaceManager: new WorkspaceManager({ strategy: "mock" }),
      executeVerificationCommands: false,
      maxSparkWorkers: 2,
    });

    const result = await orchestrator.run("model choice", await project());

    assert.equal(result.status, "pass");
    assert.deepEqual(new Set(seenModels), new Set(["alpha-model", "beta-model"]));
    assert.equal(result.modelUsage.byModel["alpha-model"].threadCount, 1);
    assert.equal(result.modelUsage.byModel["beta-model"].threadCount, 1);
  });
});
