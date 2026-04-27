import { isImplementationRole } from "../agents/roles.js";
import { hasPathOverlap } from "./path-safety.js";
import type { AgentRole, TaskContract, TaskDAG, ValidationResult } from "./types.js";
import { createValidationResult } from "./validation.js";

function hasDependencyPath(
  tasksById: Map<string, TaskContract>,
  fromTaskId: string,
  toTaskId: string,
  seen = new Set<string>()
): boolean {
  if (fromTaskId === toTaskId) {
    return true;
  }
  if (seen.has(fromTaskId)) {
    return false;
  }
  seen.add(fromTaskId);
  const task = tasksById.get(fromTaskId);
  if (!task) {
    return false;
  }
  return task.dependencies.some((dependency) =>
    hasDependencyPath(tasksById, dependency, toTaskId, seen)
  );
}

function hasCycle(tasks: TaskContract[]): string | undefined {
  const tasksById = new Map(tasks.map((task) => [task.taskId, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(taskId: string): string | undefined {
    if (visiting.has(taskId)) {
      return taskId;
    }
    if (visited.has(taskId)) {
      return undefined;
    }

    visiting.add(taskId);
    const task = tasksById.get(taskId);
    for (const dependency of task?.dependencies ?? []) {
      const cyclicTaskId = visit(dependency);
      if (cyclicTaskId) {
        return cyclicTaskId;
      }
    }
    visiting.delete(taskId);
    visited.add(taskId);
    return undefined;
  }

  for (const task of tasks) {
    const cyclicTaskId = visit(task.taskId);
    if (cyclicTaskId) {
      return cyclicTaskId;
    }
  }

  return undefined;
}

function taskDependsOnRole(
  tasksById: Map<string, TaskContract>,
  task: TaskContract,
  role: AgentRole
): boolean {
  return task.dependencies.some((dependencyId) => {
    const dependency = tasksById.get(dependencyId);
    if (!dependency) {
      return false;
    }
    return dependency.role === role || taskDependsOnRole(tasksById, dependency, role);
  });
}

function isGlobalSharedWritePath(writePath: string): boolean {
  const normalized = writePath.replace(/\\/g, "/");
  const basename = normalized.split("/").at(-1) ?? normalized;
  return (
    normalized === "package.json" ||
    normalized === "pnpm-lock.yaml" ||
    normalized === "package-lock.json" ||
    normalized === "yarn.lock" ||
    normalized === "tsconfig.json" ||
    normalized === "src/index.ts" ||
    basename.endsWith(".config.js") ||
    basename.endsWith(".config.ts") ||
    basename.endsWith(".config.mjs")
  );
}

export function validateTaskDAG(dag: TaskDAG): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const taskIds = new Set<string>();
  const duplicateIds = new Set<string>();

  for (const task of dag.tasks) {
    if (taskIds.has(task.taskId)) {
      duplicateIds.add(task.taskId);
    }
    taskIds.add(task.taskId);
  }

  for (const duplicateId of duplicateIds) {
    errors.push(`Duplicate taskId: ${duplicateId}`);
  }

  for (const task of dag.tasks) {
    for (const dependency of task.dependencies) {
      if (!taskIds.has(dependency)) {
        errors.push(`Task ${task.taskId} depends on missing task ${dependency}`);
      }
    }
  }

  for (const edge of dag.edges) {
    if (!taskIds.has(edge.from)) {
      errors.push(`DAG edge references missing from task ${edge.from}`);
    }
    if (!taskIds.has(edge.to)) {
      errors.push(`DAG edge references missing to task ${edge.to}`);
    }
  }

  const cyclicTaskId = hasCycle(dag.tasks);
  if (cyclicTaskId) {
    errors.push(`DAG contains a cycle involving task ${cyclicTaskId}`);
  }

  const tasksById = new Map(dag.tasks.map((task) => [task.taskId, task]));
  for (let i = 0; i < dag.tasks.length; i += 1) {
    for (let j = i + 1; j < dag.tasks.length; j += 1) {
      const left = dag.tasks[i];
      const right = dag.tasks[j];

      if (hasPathOverlap(left.writePaths, right.writePaths)) {
        const ordered =
          hasDependencyPath(tasksById, left.taskId, right.taskId) ||
          hasDependencyPath(tasksById, right.taskId, left.taskId);
        if (!ordered) {
          errors.push(
            `Tasks ${left.taskId} and ${right.taskId} have overlapping writePaths without ordering`
          );
        }
      }
    }
  }

  for (const task of dag.tasks) {
    if (!task.model?.trim()) {
      errors.push(`Task ${task.taskId} must declare a concrete model`);
    }

    if (!task.modelTier) {
      errors.push(`Task ${task.taskId} must declare modelTier`);
    }

    if (!task.reasoningEffort) {
      errors.push(`Task ${task.taskId} must declare reasoningEffort`);
    }

    if (!Array.isArray(task.validationTools)) {
      errors.push(`Task ${task.taskId} must declare validationTools`);
    }

    if (!Array.isArray(task.expectedOutputs)) {
      errors.push(`Task ${task.taskId} must declare expectedOutputs`);
    }

    if (!Array.isArray(task.notes)) {
      errors.push(`Task ${task.taskId} must declare notes`);
    }

    if (hasPathOverlap(task.writePaths, task.forbiddenPaths)) {
      errors.push(`Task ${task.taskId} writePaths overlap forbiddenPaths`);
    }

    if (
      task.role === "component-worker" &&
      task.writePaths.some(isGlobalSharedWritePath) &&
      !task.notes?.includes("allow-shared-write")
    ) {
      errors.push(
        `Component worker ${task.taskId} cannot write shared barrel, package, lock, or global config paths without allow-shared-write note`
      );
    }
  }

  const hasComponentTasks = dag.tasks.some((task) => task.role === "component-worker");
  const hasLayoutTasks = dag.tasks.some((task) => task.role === "layout-worker");

  for (const layoutTask of dag.tasks.filter((task) => task.role === "layout-worker")) {
    if (hasComponentTasks && !taskDependsOnRole(tasksById, layoutTask, "component-worker")) {
      errors.push(`Layout worker ${layoutTask.taskId} must depend on related component-worker tasks`);
    }
  }

  for (const screenTask of dag.tasks.filter((task) => task.role === "screen-worker")) {
    if (hasLayoutTasks && !taskDependsOnRole(tasksById, screenTask, "layout-worker")) {
      errors.push(`Screen worker ${screenTask.taskId} must depend on related layout-worker tasks`);
    }
  }

  const implementationTaskIds = dag.tasks
    .filter((task) => isImplementationRole(task.role))
    .map((task) => task.taskId);

  for (const reviewer of dag.tasks.filter((task) => task.role === "reviewer")) {
    const missing = implementationTaskIds.filter(
      (implementationTaskId) => !reviewer.dependencies.includes(implementationTaskId)
    );
    if (missing.length > 0) {
      errors.push(
        `Reviewer ${reviewer.taskId} does not depend on implementation tasks: ${missing.join(", ")}`
      );
    }
  }

  return createValidationResult(errors, warnings);
}

export function getReadyTasks(dag: TaskDAG, completedTaskIds: string[]): TaskContract[] {
  const completed = new Set(completedTaskIds);
  return dag.tasks.filter(
    (task) => !completed.has(task.taskId) && task.dependencies.every((id) => completed.has(id))
  );
}

function roleParallelLimit(role: AgentRole): number {
  switch (role) {
    case "component-worker":
      return 4;
    case "layout-worker":
      return 2;
    case "reviewer":
      return 4;
    case "screen-worker":
    case "verifier":
    case "merge-broker":
    case "planner":
      return 1;
  }
}

function canRunInSameGroup(candidate: TaskContract, group: TaskContract[]): boolean {
  const sameRoleCount = group.filter((task) => task.role === candidate.role).length;
  if (sameRoleCount >= roleParallelLimit(candidate.role)) {
    return false;
  }

  return group.every((existing) => {
    const hasDirectDependency =
      candidate.dependencies.includes(existing.taskId) ||
      existing.dependencies.includes(candidate.taskId);
    if (hasDirectDependency) {
      return false;
    }
    if (hasPathOverlap(candidate.writePaths, existing.writePaths)) {
      return false;
    }
    if (
      hasPathOverlap(candidate.writePaths, existing.forbiddenPaths) ||
      hasPathOverlap(existing.writePaths, candidate.forbiddenPaths)
    ) {
      return false;
    }
    return true;
  });
}

export function groupParallelTasks(tasks: TaskContract[]): TaskContract[][] {
  const groups: TaskContract[][] = [];

  for (const task of tasks) {
    const targetGroup = groups.find((group) => canRunInSameGroup(task, group));
    if (targetGroup) {
      targetGroup.push(task);
    } else {
      groups.push([task]);
    }
  }

  return groups;
}
