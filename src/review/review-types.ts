import type { CommandRunResult, TaskContract } from "../core/types.js";

export type ReviewType = "contract" | "integration" | "architecture" | "security";

export interface ReviewIssue {
  severity: "low" | "medium" | "high" | "critical";
  file?: string;
  evidence: string;
  requiredFix: string;
}

export interface ReviewResult {
  reviewerId: string;
  reviewType: ReviewType;
  status: "pass" | "needs_changes" | "reject";
  summary: string;
  blockingIssues: ReviewIssue[];
  nonBlockingIssues: ReviewIssue[];
  commandsRun: CommandRunResult[];
  suggestedFixTasks: TaskContract[];
}

export interface ReviewAggregationResult {
  status: "pass" | "needs_changes" | "reject";
  summary: string;
  blockingIssues: ReviewIssue[];
  nonBlockingIssues: ReviewIssue[];
  suggestedFixTasks: TaskContract[];
}
