import { rejects } from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test as runAgent, MockModelRunner, WorkspaceManager } from "../dist/index.js";
import { describe, it } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

describe("test()", () => {
  it("rejects when repo is not a git work tree", async () => {
    await rejects(
      runAgent("hello", "/nonexistent-path-" + Date.now(), "main"),
      /Not a git repository/
    );
  });

  it("exports test as a function", () => {
    if (typeof runAgent !== "function") {
      throw new Error("expected test to be a function");
    }
  });

  it("can run through the orchestrator with an injected model runner", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "code-agent-sdk-entry-"));
    await writeFile(path.join(repo, "package.json"), '{"type":"module"}\n', "utf8");
    await execFileAsync("git", ["-C", repo, "init", "-b", "main"]);
    await execFileAsync("git", ["-C", repo, "add", "."]);
    await execFileAsync("git", ["-C", repo, "commit", "-m", "init"]);

    const result = await runAgent("demo", repo, "main", {
      orchestrator: {
        modelRunner: new MockModelRunner(),
        workspaceManager: new WorkspaceManager({ strategy: "mock" }),
        executeVerificationCommands: false,
      },
    });

    if (result.status !== "pass") {
      throw new Error(`expected orchestrated pass, got ${result.status}: ${result.summary}`);
    }
    if (!result.taskResults.some((item) => item.workerId.startsWith("spark-worker-"))) {
      throw new Error("expected Spark worker results from orchestrator path");
    }
  });
});
