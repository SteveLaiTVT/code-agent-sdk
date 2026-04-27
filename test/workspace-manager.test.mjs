import { strict as assert } from "node:assert";
import { lstat, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { WorkspaceManager } from "../dist/index.js";

describe("WorkspaceManager", () => {
  it("links node_modules into validation workspaces when present in the source project", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workspace-manager-project-"));
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "node_modules", "demo-pkg"), { recursive: true });
    await writeFile(path.join(root, "package.json"), '{"type":"module"}\n', "utf8");
    await writeFile(path.join(root, "src", "index.js"), 'export const ok = true;\n', "utf8");
    await writeFile(
      path.join(root, "node_modules", "demo-pkg", "package.json"),
      '{"name":"demo-pkg","version":"1.0.0"}\n',
      "utf8"
    );

    const manager = new WorkspaceManager();
    const workspacePath = await manager.createValidationWorkspace(
      { projectId: "workspace-manager", root },
      "validation-support"
    );

    const linkedNodeModules = path.join(workspacePath, "node_modules");
    const stats = await lstat(linkedNodeModules);

    assert.equal(stats.isSymbolicLink(), true);
    await manager.cleanupValidationWorkspace(workspacePath);
  });
});
