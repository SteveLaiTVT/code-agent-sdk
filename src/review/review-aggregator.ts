import type { ReviewAggregationResult, ReviewIssue, ReviewResult } from "./review-types.js";

function highestSeverity(issues: ReviewIssue[]): ReviewIssue["severity"] | undefined {
  const order: ReviewIssue["severity"][] = ["low", "medium", "high", "critical"];
  return issues
    .map((issue) => issue.severity)
    .sort((left, right) => order.indexOf(right) - order.indexOf(left))[0];
}

export class ReviewAggregator {
  aggregate(results: ReviewResult[]): ReviewAggregationResult {
    const blockingIssues = results.flatMap((result) => result.blockingIssues);
    const nonBlockingIssues = results.flatMap((result) => result.nonBlockingIssues);
    const suggestedFixTasks = results.flatMap((result) => result.suggestedFixTasks);
    const highestBlockingSeverity = highestSeverity(blockingIssues);

    let status: ReviewAggregationResult["status"] = "pass";

    if (
      highestBlockingSeverity === "critical" ||
      results.some((result) => result.status === "reject")
    ) {
      status = "reject";
    } else if (
      highestBlockingSeverity === "high" ||
      highestBlockingSeverity === "medium" ||
      results.some((result) => result.status === "needs_changes") ||
      results.some(
        (result) => result.reviewType === "integration" && result.status !== "pass"
      )
    ) {
      status = "needs_changes";
    }

    return {
      status,
      summary: this.createSummary(status, results, blockingIssues, nonBlockingIssues),
      blockingIssues,
      nonBlockingIssues,
      suggestedFixTasks: status === "needs_changes" ? suggestedFixTasks : [],
    };
  }

  private createSummary(
    status: ReviewAggregationResult["status"],
    results: ReviewResult[],
    blockingIssues: ReviewIssue[],
    nonBlockingIssues: ReviewIssue[]
  ): string {
    const reviewCounts = results.reduce<Record<string, number>>((acc, result) => {
      acc[result.status] = (acc[result.status] ?? 0) + 1;
      return acc;
    }, {});
    return [
      `Review aggregation status: ${status}.`,
      `Reviews: pass=${reviewCounts.pass ?? 0}, needs_changes=${reviewCounts.needs_changes ?? 0}, reject=${reviewCounts.reject ?? 0}.`,
      `Issues: blocking=${blockingIssues.length}, nonBlocking=${nonBlockingIssues.length}.`,
    ].join(" ");
  }
}
