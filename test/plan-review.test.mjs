import { strict as assert } from "node:assert";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  AgentOrchestrator,
  MockModelRunner,
  WorkspaceManager,
  runCodingTask,
} from "../dist/index.js";

function componentTask(taskId, model = "gpt-5.3-codex-spark") {
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
    projectId: "plan-review-test",
    root: await mkdtemp(path.join(os.tmpdir(), "plan-review-")),
  };
}

async function nextEvent(iterator) {
  const next = await iterator.next();
  assert.equal(next.done, false);
  return next.value;
}

async function readUntil(iterator, events, type) {
  while (true) {
    const event = await nextEvent(iterator);
    events.push(event);
    if (event.type === type) {
      return event;
    }
  }
}

async function drain(iterator, events) {
  while (true) {
    const next = await iterator.next();
    if (next.done) {
      return;
    }
    events.push(next.value);
  }
}

describe("manual plan review", () => {
  it("does not start implementation until the plan is approved", async () => {
    const orchestrator = new AgentOrchestrator({
      modelRunner: new MockModelRunner(),
      workspaceManager: new WorkspaceManager({ strategy: "mock" }),
      executeVerificationCommands: false,
      planReview: { mode: "manual" },
    });
    const stream = orchestrator.runStreamed("manual approval", await project());
    assert.ok(stream.planReview);

    const iterator = stream.events[Symbol.asyncIterator]();
    const events = [];
    const required = await readUntil(iterator, events, "plan.review.required");

    assert.equal(required.revisionIndex, 0);
    assert.deepEqual(
      required.options.map((option) => option.action),
      ["approve", "revise", "cancel"]
    );
    assert.equal(events.some((event) => event.type === "task.started"), false);

    stream.planReview.approve();
    const result = await stream.result;
    await drain(iterator, events);

    assert.equal(result.status, "pass");
    assert.ok(events.some((event) => event.type === "plan.review.approved"));
    assert.ok(events.some((event) => event.type === "task.started"));
  });

  it("replans with revision feedback before implementation", async () => {
    const plannerCalls = [];
    class RevisionModelRunner extends MockModelRunner {
      async runPlanner(requirement, context = {}) {
        plannerCalls.push({
          requirement,
          planRevision: context.planRevision,
        });
        const taskId = `task-${plannerCalls.length}`;
        return {
          dagId: `dag-${plannerCalls.length}`,
          tasks: [componentTask(taskId, "revision-model")],
          edges: [],
        };
      }
    }

    const orchestrator = new AgentOrchestrator({
      modelRunner: new RevisionModelRunner(),
      workspaceManager: new WorkspaceManager({ strategy: "mock" }),
      executeVerificationCommands: false,
      planReview: { mode: "manual" },
    });
    const stream = orchestrator.runStreamed("revise plan", await project());
    const iterator = stream.events[Symbol.asyncIterator]();
    const events = [];

    await readUntil(iterator, events, "plan.review.required");
    stream.planReview.revise("Split the risky task into a smaller implementation task.");
    const secondRequired = await readUntil(iterator, events, "plan.review.required");
    stream.planReview.approve();
    const result = await stream.result;
    await drain(iterator, events);

    assert.equal(secondRequired.revisionIndex, 1);
    assert.equal(plannerCalls.length, 2);
    assert.equal(plannerCalls[0].planRevision, undefined);
    assert.equal(
      plannerCalls[1].planRevision.feedback,
      "Split the risky task into a smaller implementation task."
    );
    assert.equal(plannerCalls[1].planRevision.previousDag.dagId, "dag-1");
    assert.deepEqual(
      result.taskResults.map((item) => item.taskId),
      ["task-2"]
    );
    assert.equal(
      events.some((event) => event.type === "task.started" && event.task.taskId === "task-1"),
      false
    );
  });

  it("can cancel a pending plan without starting workers", async () => {
    const orchestrator = new AgentOrchestrator({
      modelRunner: new MockModelRunner(),
      workspaceManager: new WorkspaceManager({ strategy: "mock" }),
      executeVerificationCommands: false,
      planReview: { mode: "manual" },
    });
    const stream = orchestrator.runStreamed("cancel plan", await project());
    const iterator = stream.events[Symbol.asyncIterator]();
    const events = [];

    await readUntil(iterator, events, "plan.review.required");
    stream.planReview.cancel("Needs a narrower requirement.");
    const result = await stream.result;
    await drain(iterator, events);

    assert.equal(result.status, "cancelled");
    assert.match(result.summary, /Needs a narrower requirement/);
    assert.equal(events.some((event) => event.type === "task.started"), false);
    assert.equal(events.some((event) => event.type === "merge.completed"), false);
    assert.equal(events.some((event) => event.type === "review.completed"), false);
    assert.ok(events.some((event) => event.type === "plan.review.cancelled"));
  });

  it("rejects non-streamed APIs when manual plan review is enabled", async () => {
    const orchestrator = new AgentOrchestrator({
      modelRunner: new MockModelRunner(),
      workspaceManager: new WorkspaceManager({ strategy: "mock" }),
      executeVerificationCommands: false,
      planReview: { mode: "manual" },
    });

    await assert.rejects(orchestrator.run("guard", await project()), /streamed API/);
    await assert.rejects(
      runCodingTask("guard", "/missing-repo-for-plan-review", "main", {
        orchestrator: { planReview: { mode: "manual" } },
      }),
      /runCodingTaskStreamed/
    );
  });
});
