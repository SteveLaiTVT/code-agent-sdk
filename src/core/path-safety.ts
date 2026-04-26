import path from "node:path";
import type { ProjectSpace, TaskContract } from "./types.js";

const SENSITIVE_PATH_SEGMENTS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
]);

function stripTrailingSeparator(value: string): string {
  if (value === path.parse(value).root) {
    return value;
  }
  return value.replace(new RegExp(`${path.sep.replace("\\", "\\\\")}+$`), "");
}

function normalizeForOverlap(value: string): string {
  const resolved = path.isAbsolute(value) ? path.resolve(value) : path.resolve("/", value);
  return stripTrailingSeparator(resolved);
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function hasParentTraversal(inputPath: string): boolean {
  return inputPath.split(/[\\/]+/).includes("..");
}

function isSensitiveWritePath(inputPath: string): boolean {
  const normalized = inputPath.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  const basename = segments.at(-1) ?? "";
  return (
    basename === ".env" ||
    basename.startsWith(".env.") ||
    segments.some((segment) => SENSITIVE_PATH_SEGMENTS.has(segment))
  );
}

export function assertInsideProject(projectRoot: string, targetPath: string): string {
  const root = path.resolve(projectRoot);
  const target = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(root, targetPath);

  if (!isInside(root, target)) {
    throw new Error(`Path escapes project root: ${target}`);
  }

  return target;
}

export function resolveInsideProject(projectRoot: string, relativePath: string): string {
  return assertInsideProject(projectRoot, relativePath);
}

export function hasPathOverlap(a: string[], b: string[]): boolean {
  const left = a.map(normalizeForOverlap);
  const right = b.map(normalizeForOverlap);

  return left.some((leftPath) =>
    right.some((rightPath) => isInside(leftPath, rightPath) || isInside(rightPath, leftPath))
  );
}

export function assertTaskScopeSafe(project: ProjectSpace, task: TaskContract): void {
  const allScopedPaths = [
    ...task.readPaths,
    ...task.writePaths,
    ...task.forbiddenPaths,
  ];

  for (const scopedPath of allScopedPaths) {
    if (hasParentTraversal(scopedPath)) {
      throw new Error(`Task ${task.taskId} contains parent traversal path: ${scopedPath}`);
    }
    assertInsideProject(project.root, scopedPath);
  }

  for (const writePath of task.writePaths) {
    if (isSensitiveWritePath(writePath)) {
      throw new Error(`Task ${task.taskId} cannot write sensitive or generated path: ${writePath}`);
    }
  }

  if (hasPathOverlap(task.writePaths, task.forbiddenPaths)) {
    throw new Error(`Task ${task.taskId} writePaths overlap forbiddenPaths`);
  }
}

export function isPathWithinAnyPath(candidatePath: string, allowedPaths: string[]): boolean {
  const candidate = normalizeForOverlap(candidatePath);
  return allowedPaths
    .map(normalizeForOverlap)
    .some((allowedPath) => isInside(allowedPath, candidate));
}

export function toProjectRelativePath(projectRoot: string, targetPath: string): string {
  const absolute = assertInsideProject(projectRoot, targetPath);
  return path.relative(path.resolve(projectRoot), absolute).replace(/\\/g, "/");
}
