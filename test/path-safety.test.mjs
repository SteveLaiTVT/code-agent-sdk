import { strict as assert } from "node:assert";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { assertInsideProject, assertTaskScopeSafe, resolveInsideProject } from "../dist/index.js";

function task(overrides = {}) {
  return {
    taskId: "task",
    title: "Task",
    role: "component-worker",
    model: "test-model",
    modelTier: "spark",
    reasoningEffort: "low",
    objective: "test",
    readPaths: ["src"],
    writePaths: ["src/generated/file.ts"],
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

describe("path safety", () => {
  it("allows paths inside project root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "path-safe-"));
    assert.equal(resolveInsideProject(root, "src/index.ts"), path.join(root, "src/index.ts"));
    assert.equal(assertInsideProject(root, path.join(root, "src/index.ts")), path.join(root, "src/index.ts"));
  });

  it("rejects parent traversal escape", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "path-safe-"));
    assert.throws(() => resolveInsideProject(root, "../outside.ts"), /escapes project root/);
    assert.throws(
      () => assertTaskScopeSafe({ projectId: "p", root }, task({ writePaths: ["../outside.ts"] })),
      /parent traversal/
    );
  });

  it("rejects forbidden path writes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "path-safe-"));
    assert.throws(
      () =>
        assertTaskScopeSafe(
          { projectId: "p", root },
          task({ writePaths: ["src/secret.ts"], forbiddenPaths: ["src"] })
        ),
      /overlap forbiddenPaths/
    );
  });

  it("rejects .env writes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "path-safe-"));
    assert.throws(
      () => assertTaskScopeSafe({ projectId: "p", root }, task({ writePaths: [".env"] })),
      /sensitive or generated path/
    );
  });

  it("rejects .git and node_modules writes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "path-safe-"));
    assert.throws(
      () => assertTaskScopeSafe({ projectId: "p", root }, task({ writePaths: [".git/config"] })),
      /sensitive or generated path/
    );
    assert.throws(
      () =>
        assertTaskScopeSafe({ projectId: "p", root }, task({ writePaths: ["node_modules/pkg.js"] })),
      /sensitive or generated path/
    );
  });
});
