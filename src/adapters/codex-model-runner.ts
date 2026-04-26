import type {
  ModelRunner,
  ModelRunnerReviewerInput,
  ModelRunnerWorkerInput,
  ModelRunnerWorkerOutput,
} from "../agents/model-runner.js";
import type { TaskDAG } from "../core/types.js";
import type { ReviewResult } from "../review/review-types.js";

export interface CodexModelRunnerAdapterConfig {
  plannerModel: string;
  componentWorkerModel: string;
  layoutWorkerModel: string;
  screenWorkerModel: string;
  reviewerModel: string;
}

export const defaultCodexModelRunnerAdapterConfig: CodexModelRunnerAdapterConfig = {
  plannerModel: "gpt-5.5",
  componentWorkerModel: "gpt-5.3-codex-spark",
  layoutWorkerModel: "gpt-5.4-mini",
  screenWorkerModel: "gpt-5.5",
  reviewerModel: "gpt-5.5",
};

export class CodexModelRunnerAdapter implements ModelRunner {
  readonly config: CodexModelRunnerAdapterConfig;

  constructor(config: Partial<CodexModelRunnerAdapterConfig> = {}) {
    this.config = {
      ...defaultCodexModelRunnerAdapterConfig,
      ...config,
    };
  }

  async runPlanner(_requirement: string): Promise<TaskDAG> {
    throw new Error(
      "CodexModelRunnerAdapter.runPlanner is an adapter boundary. Wire Codex SDK/OpenAI API here and return a validated TaskDAG."
    );
  }

  async runWorker(_input: ModelRunnerWorkerInput): Promise<ModelRunnerWorkerOutput> {
    throw new Error(
      "CodexModelRunnerAdapter.runWorker is an adapter boundary. Run the task in its isolated workspace and return structured worker output."
    );
  }

  async runReviewer(_input: ModelRunnerReviewerInput): Promise<ReviewResult> {
    throw new Error(
      "CodexModelRunnerAdapter.runReviewer is an adapter boundary. Return a structured ReviewResult without modifying source files."
    );
  }
}
