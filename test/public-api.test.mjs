import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  buildCodeAgentArtifacts,
  runTaskSessionStreamed,
} from "../dist/index.js";

describe("public package APIs", () => {
  it("streams task session thread, message, status, usage, and raw thread events", async () => {
    const seenThreadOptions = [];
    const codex = {
      startThread(options) {
        seenThreadOptions.push(options);
        return fakeThread();
      },
      resumeThread() {
        throw new Error("resumeThread should not be used in this test");
      },
    };
    const events = [];

    for await (const event of runTaskSessionStreamed(
      {
        emitThreadEvents: true,
        message: "hello",
        model: "gpt-test",
        sandboxMode: "read-only",
        workingDirectory: "/tmp/project",
      },
      { codex },
    )) {
      events.push(event);
    }

    assert.deepEqual(seenThreadOptions[0], {
      model: "gpt-test",
      sandboxMode: "read-only",
      workingDirectory: "/tmp/project",
    });
    assert.ok(events.some((event) => event.type === "thread.event"));
    assert.ok(events.some((event) => event.type === "thread" && event.threadId === "thread-1"));
    assert.ok(events.some((event) => event.type === "message" && event.text === "Done"));
    assert.ok(events.some((event) => event.type === "status" && event.kind === "reasoning"));
    assert.ok(events.some((event) => event.type === "usage" && event.usage.outputTokens === 3));
  });

  it("builds ai-dev-ops-v1 artifacts with a non-null fallback test plan", () => {
    const result = buildCodeAgentArtifacts({
      artifactProfile: "ai-dev-ops-v1",
      orchestration: {
        dag: {
          dagId: "dag-1",
          edges: [],
          tasks: [],
        },
        mergeResults: [
          {
            changedFiles: ["src/a.ts"],
            errors: [],
            status: "merged",
            summary: "merged",
            taskId: "task-1",
            validation: {
              errors: [],
              valid: true,
              warnings: [],
            },
          },
        ],
        modelUsage: {
          byModel: {},
          totals: {
            cachedInputTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
            threadCount: 0,
            turnCount: 0,
          },
        },
        reviewResults: [],
        status: "pass",
        summary: "Implementation completed.",
        taskResults: [],
        trace: [],
        verificationResults: [],
      },
    });

    assert.equal(result.testPlan.source, "fallback");
    assert.deepEqual(result.testPlan.features, []);
    assert.deepEqual(result.changedFiles, ["src/a.ts"]);
    assert.match(result.reportMarkdown, /Functional Test Plan/);
  });
});

function fakeThread() {
  return {
    async runStreamed() {
      return {
        events: (async function* () {
          yield {
            thread_id: "thread-1",
            type: "thread.started",
          };
          yield {
            item: {
              id: "reasoning-1",
              text: "Thinking",
              type: "reasoning",
            },
            type: "item.started",
          };
          yield {
            item: {
              id: "message-1",
              text: "Done",
              type: "agent_message",
            },
            type: "item.completed",
          };
          yield {
            type: "turn.completed",
            usage: {
              cached_input_tokens: 1,
              input_tokens: 2,
              output_tokens: 3,
              reasoning_output_tokens: 4,
            },
          };
        })(),
      };
    },
  };
}
