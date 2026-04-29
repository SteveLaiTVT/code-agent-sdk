import type { TaskContract, TaskScope } from "./types.js";

export function taskContractToScope(task: TaskContract): TaskScope {
  return {
    readablePaths: task.readPaths,
    writablePaths: task.writePaths,
    forbiddenPaths: task.forbiddenPaths,
    network: task.network,
  };
}

export function isImplementationTask(task: TaskContract): boolean {
  return (
    task.role === "component-worker" ||
    task.role === "layout-worker" ||
    task.role === "screen-worker"
  );
}

export function isReviewerTask(task: TaskContract): boolean {
  return task.role === "reviewer";
}
