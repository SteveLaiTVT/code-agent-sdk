import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TaskContract } from "../core/types.js";

export interface MockPatchOperation {
  type: "write";
  path: string;
  content: string;
}

export interface MockPatchFile {
  format: "code-agent-sdk.mock-patch.v1";
  taskId: string;
  changedFiles: string[];
  operations: MockPatchOperation[];
}

function sanitizeIdentifier(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_$]/g, "_");
  return /^[a-zA-Z_$]/.test(sanitized) ? sanitized : `_${sanitized}`;
}

function createMockFileContent(task: TaskContract, filePath: string): string {
  const exportName = sanitizeIdentifier(`${task.taskId}_${path.basename(filePath, path.extname(filePath))}`);
  return [
    `export const ${exportName} = {`,
    `  taskId: ${JSON.stringify(task.taskId)},`,
    `  title: ${JSON.stringify(task.title)},`,
    `  role: ${JSON.stringify(task.role)},`,
    `  objective: ${JSON.stringify(task.objective)},`,
    "} as const;",
    "",
  ].join("\n");
}

export async function createMockPatchFile(
  workspacePath: string,
  task: TaskContract
): Promise<string> {
  const patchDir = path.join(workspacePath, ".agent-orchestrator", "patches");
  await mkdir(patchDir, { recursive: true });
  const patchPath = path.join(patchDir, `${task.taskId}.mock-patch.json`);
  const patch: MockPatchFile = {
    format: "code-agent-sdk.mock-patch.v1",
    taskId: task.taskId,
    changedFiles: task.writePaths,
    operations: task.writePaths.map((writePath) => ({
      type: "write",
      path: writePath,
      content: createMockFileContent(task, writePath),
    })),
  };
  await writeFile(patchPath, `${JSON.stringify(patch, null, 2)}\n`, "utf8");
  return patchPath;
}

export async function readMockPatchFile(patchPath: string): Promise<MockPatchFile> {
  const raw = await readFile(patchPath, "utf8");
  const parsed = JSON.parse(raw) as Partial<MockPatchFile>;

  if (parsed.format !== "code-agent-sdk.mock-patch.v1") {
    throw new Error(`Unsupported patch format in ${patchPath}`);
  }
  if (!parsed.taskId || !Array.isArray(parsed.changedFiles) || !Array.isArray(parsed.operations)) {
    throw new Error(`Invalid mock patch structure in ${patchPath}`);
  }

  return {
    format: parsed.format,
    taskId: parsed.taskId,
    changedFiles: parsed.changedFiles,
    operations: parsed.operations,
  };
}

export async function getPatchChangedFiles(patchPath: string): Promise<string[]> {
  const patch = await readMockPatchFile(patchPath);
  return patch.changedFiles;
}
