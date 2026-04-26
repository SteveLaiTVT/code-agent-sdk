import type { AgentWorker, WorkerContext, WorkerResult } from "./worker.js";
import type { TaskContract } from "../core/types.js";

export interface WorkerPoolRunOptions {
  concurrency: number;
}

export type WorkerFactory = (task: TaskContract, index: number) => AgentWorker;
export type WorkerContextFactory = (task: TaskContract) => Promise<WorkerContext>;

export class WorkerPool {
  private readonly concurrency: number;

  constructor(options: WorkerPoolRunOptions) {
    this.concurrency = Math.max(1, options.concurrency);
  }

  async run(
    tasks: TaskContract[],
    createWorker: WorkerFactory,
    createContext: WorkerContextFactory
  ): Promise<WorkerResult[]> {
    const results: WorkerResult[] = new Array(tasks.length);
    let nextIndex = 0;

    const runNext = async (): Promise<void> => {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= tasks.length) {
        return;
      }

      const task = tasks[index];
      const worker = createWorker(task, index);
      const context = await createContext(task);
      results[index] = await worker.run(task, context);
      await runNext();
    };

    const workerCount = Math.min(this.concurrency, tasks.length);
    await Promise.all(Array.from({ length: workerCount }, () => runNext()));
    return results;
  }
}

export class SparkWorkerPool extends WorkerPool {
  constructor(maxSparkWorkers = 4) {
    super({ concurrency: maxSparkWorkers });
  }
}
