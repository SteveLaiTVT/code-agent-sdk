import { strict as assert } from "node:assert";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createCodexOptions } from "../dist/index.js";

async function project() {
  return {
    projectId: "p",
    root: await mkdtemp(path.join(os.tmpdir(), "codex-options-")),
  };
}

describe("createCodexOptions", () => {
  it("planner is read-only", async () => {
    const options = createCodexOptions({ role: "planner", project: await project() });
    assert.equal(options.config.sandbox_mode, "read-only");
    assert.deepEqual(options.config.sandbox_workspace_write.writable_roots, []);
  });

  it("component worker can only write taskScope writable paths", async () => {
    const p = await project();
    const options = createCodexOptions({
      role: "component-worker",
      project: p,
      taskScope: {
        writablePaths: ["src/component.ts"],
        reportPaths: [".agent-orchestrator/reports/component"],
      },
    });
    assert.equal(options.config.sandbox_mode, "workspace-write");
    assert.deepEqual(options.config.sandbox_workspace_write.writable_roots.sort(), [
      path.join(p.root, ".agent-orchestrator/reports/component"),
      path.join(p.root, "src/component.ts"),
    ].sort());
  });

  it("reviewer blocks shell network but allows webSearch and mcpRead", async () => {
    const options = createCodexOptions({ role: "reviewer", project: await project() });
    assert.equal(options.config.sandbox_workspace_write.network_access, false);
    assert.equal(options.toolPermissions.webSearch, true);
    assert.equal(options.toolPermissions.mcpRead, true);
    assert.equal(options.toolPermissions.mcpWrite, false);
  });

  it("shell environment excludes secrets", async () => {
    const options = createCodexOptions({ role: "planner", project: await project() });
    const excludes = options.config.shell_environment_policy.exclude;
    assert.ok(excludes.includes("*TOKEN*"));
    assert.ok(excludes.includes("*KEY*"));
    assert.ok(excludes.includes("*SECRET*"));
  });
});
