import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { ReviewAggregator } from "../dist/index.js";

function review(overrides = {}) {
  return {
    reviewerId: "reviewer",
    reviewType: "contract",
    status: "pass",
    summary: "pass",
    blockingIssues: [],
    nonBlockingIssues: [],
    commandsRun: [],
    suggestedFixTasks: [],
    ...overrides,
  };
}

function issue(severity) {
  return {
    severity,
    evidence: `${severity} evidence`,
    requiredFix: `${severity} fix`,
  };
}

describe("ReviewAggregator", () => {
  it("rejects critical blocking issue", () => {
    const result = new ReviewAggregator().aggregate([
      review({ blockingIssues: [issue("critical")] }),
    ]);
    assert.equal(result.status, "reject");
  });

  it("marks high blocking issue as needs_changes", () => {
    const result = new ReviewAggregator().aggregate([
      review({ blockingIssues: [issue("high")] }),
    ]);
    assert.equal(result.status, "needs_changes");
  });

  it("passes with only low non-blocking issue", () => {
    const result = new ReviewAggregator().aggregate([
      review({ nonBlockingIssues: [issue("low")] }),
    ]);
    assert.equal(result.status, "pass");
  });
});
