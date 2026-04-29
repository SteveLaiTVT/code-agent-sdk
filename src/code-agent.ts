import type { AgentOrchestratorOptions } from "./agents/orchestrator.js";
import type { CodexModelRunnerAdapterConfig } from "./adapters/codex-model-runner.js";
import type {
  ModelUsageSummary,
  OrchestrationEvent,
  OrchestrationResult,
  OrchestrationStream,
  ThreadRunTrace,
} from "./core/types.js";
import { runCodingTaskStreamed, type RunCodingTaskOptions } from "./index.js";

export type CodeAgentArtifactProfile = "ai-dev-ops-v1";

export type TestPlanAction =
  | "launch"
  | "tap"
  | "input_text"
  | "wait_for_text"
  | "assert_text"
  | "press_back"
  | "screenshot"
  | "collect_logcat";

export type TestPlanSelector = {
  by: "text" | "resource-id" | "content-desc";
  value: string;
  match?: "exact" | "contains";
};

export type TestPlanStepSpec = {
  action: TestPlanAction;
  id: string;
  label: string;
  expectedResult?: string;
  selector?: TestPlanSelector;
  text?: string;
  timeoutMs?: number;
};

export type TestPlanFeatureSpec = {
  description: string;
  expectedResults: string[];
  id: string;
  outOfScope: string[];
  prerequisites: string[];
  riskNotes: string[];
  steps: TestPlanStepSpec[];
  title: string;
};

export type TestPlanSpec = {
  deviceRequirements: string[];
  features: TestPlanFeatureSpec[];
  outOfScope: string[];
  prerequisites: string[];
  riskNotes: string[];
  source: "code-agent" | "manual" | "fallback";
  summary: string;
};

export type RunCodeAgentStreamedInput = {
  /** User requirement that should be planned and implemented in the target repo. */
  requirement: string;
  /** Local target repository path. The directory must be a Git repository. */
  repo: string;
  /** Branch to checkout before planning and implementation. */
  branch: string;
  /** Extra artifact shape to derive from the orchestration result. */
  artifactProfile: CodeAgentArtifactProfile;
  /** Stable id used in traces and reports. */
  projectId?: string;
  /** Concrete model names for planner, workers, and reviewers. */
  modelConfig?: Partial<CodexModelRunnerAdapterConfig>;
  /** Orchestrator controls, including manual plan review. */
  orchestrator?: Partial<AgentOrchestratorOptions>;
};

export type CodeAgentStreamedResult = {
  orchestration: OrchestrationResult;
  reportMarkdown: string;
  testPlan: TestPlanSpec;
  modelUsage: ModelUsageSummary;
  trace: ThreadRunTrace[];
  changedFiles: string[];
};

export type CodeAgentStream = {
  /** Orchestration event stream. Listen for plan.review.required before approving manual runs. */
  events: AsyncIterable<OrchestrationEvent>;
  /** Final result plus report/test-plan artifacts. */
  result: Promise<CodeAgentStreamedResult>;
  /** Manual approval controller. Present only when planReview.mode is manual. */
  planReview?: OrchestrationStream["planReview"];
};

export async function runCodeAgentStreamed(
  input: RunCodeAgentStreamedInput,
): Promise<CodeAgentStream> {
  const options: RunCodingTaskOptions = {
    projectId: input.projectId,
    modelConfig: input.modelConfig,
    orchestrator: input.orchestrator,
  };
  const stream = await runCodingTaskStreamed(input.requirement, input.repo, input.branch, options);

  return {
    events: stream.events,
    planReview: stream.planReview,
    result: stream.result.then((orchestration) =>
      buildCodeAgentArtifacts({
        artifactProfile: input.artifactProfile,
        orchestration,
      }),
    ),
  };
}

export function buildCodeAgentArtifacts(input: {
  artifactProfile: CodeAgentArtifactProfile;
  orchestration: OrchestrationResult;
}): CodeAgentStreamedResult {
  if (input.artifactProfile !== "ai-dev-ops-v1") {
    throw new Error(`Unsupported code-agent artifact profile: ${input.artifactProfile}`);
  }

  const changedFiles = collectChangedFiles(input.orchestration);
  const testPlan =
    extractTestPlanSpecFromText(input.orchestration.summary) ??
    createFallbackTestPlan(input.orchestration);

  return {
    orchestration: input.orchestration,
    reportMarkdown: buildReportMarkdown({
      changedFiles,
      orchestration: input.orchestration,
      testPlan,
    }),
    testPlan,
    modelUsage: input.orchestration.modelUsage,
    trace: input.orchestration.trace,
    changedFiles,
  };
}

function collectChangedFiles(result: OrchestrationResult) {
  return [
    ...new Set([
      ...result.taskResults.flatMap((task) => task.changedFiles),
      ...result.mergeResults.flatMap((merge) => merge.changedFiles),
    ]),
  ].sort();
}

function buildReportMarkdown(input: {
  changedFiles: string[];
  orchestration: OrchestrationResult;
  testPlan: TestPlanSpec;
}) {
  return [
    "# Code-Agent Report",
    "",
    `Status: ${input.orchestration.status}`,
    "",
    "## Summary",
    input.orchestration.summary || "Orchestration completed without a summary.",
    "",
    "## Changed Files",
    ...(input.changedFiles.length > 0
      ? input.changedFiles.map((file) => `- ${file}`)
      : ["- none reported"]),
    "",
    "## Verification",
    ...formatVerification(input.orchestration),
    "",
    "## Functional Test Plan",
    `- Source: ${input.testPlan.source}`,
    `- Feature points: ${input.testPlan.features.length}`,
    `- Summary: ${input.testPlan.summary}`,
    ...(input.testPlan.riskNotes.length > 0
      ? ["", "## Test Risks", ...input.testPlan.riskNotes.map((risk) => `- ${risk}`)]
      : []),
  ].join("\n");
}

function formatVerification(result: OrchestrationResult) {
  if (result.verificationResults.length === 0) {
    return ["- No verification result was reported by the orchestration run."];
  }

  return result.verificationResults.map(
    (verification) => `- ${verification.status}: ${verification.summary}`,
  );
}

function createFallbackTestPlan(orchestration: OrchestrationResult): TestPlanSpec {
  const hasImplementationOutput =
    orchestration.taskResults.length > 0 || orchestration.mergeResults.length > 0;

  return {
    deviceRequirements: ["USB Android core device with the target APK installed by TestAgent"],
    features: [],
    outOfScope: ["Feature-level Android coverage was not inferred from the orchestration output."],
    prerequisites: [],
    riskNotes: [
      hasImplementationOutput
        ? "Code-Agent did not produce a reliable feature test plan; TestAgent should run base smoke coverage only."
        : "Code-Agent produced no implementation output; TestAgent should run base smoke coverage only after a build artifact exists.",
    ],
    source: "fallback",
    summary: "No reliable functional test points were generated; run base smoke only.",
  };
}

function extractTestPlanSpecFromText(text: string): TestPlanSpec | null {
  const match = text.match(/```(?:testplan|json)\s*([\s\S]*?)```/i);

  if (!match) {
    return null;
  }

  try {
    return normalizeTestPlan(JSON.parse(match[1]));
  } catch {
    return null;
  }
}

function normalizeTestPlan(value: unknown): TestPlanSpec | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<TestPlanSpec> & {
    testPlan?: unknown;
    testPlanSpec?: unknown;
  };

  if (candidate.testPlan || candidate.testPlanSpec) {
    return normalizeTestPlan(candidate.testPlan ?? candidate.testPlanSpec);
  }

  if (!Array.isArray(candidate.features)) {
    return null;
  }

  return {
    deviceRequirements: stringArray(candidate.deviceRequirements),
    features: candidate.features.flatMap((feature) => normalizeFeature(feature)),
    outOfScope: stringArray(candidate.outOfScope),
    prerequisites: stringArray(candidate.prerequisites),
    riskNotes: stringArray(candidate.riskNotes),
    source:
      candidate.source === "code-agent" || candidate.source === "manual"
        ? candidate.source
        : "fallback",
    summary:
      typeof candidate.summary === "string" && candidate.summary.trim()
        ? candidate.summary.trim()
        : "Functional test plan generated by Code-Agent.",
  };
}

function normalizeFeature(value: unknown): TestPlanFeatureSpec[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const feature = value as Partial<TestPlanFeatureSpec>;
  if (typeof feature.id !== "string" || typeof feature.title !== "string") {
    return [];
  }

  return [
    {
      description: typeof feature.description === "string" ? feature.description : feature.title,
      expectedResults: stringArray(feature.expectedResults),
      id: feature.id,
      outOfScope: stringArray(feature.outOfScope),
      prerequisites: stringArray(feature.prerequisites),
      riskNotes: stringArray(feature.riskNotes),
      steps: Array.isArray(feature.steps)
        ? feature.steps.flatMap((step) => normalizeStep(step))
        : [],
      title: feature.title,
    },
  ];
}

function normalizeStep(value: unknown): TestPlanStepSpec[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const step = value as Partial<TestPlanStepSpec>;
  if (typeof step.id !== "string" || typeof step.label !== "string" || !isTestPlanAction(step.action)) {
    return [];
  }

  return [
    {
      action: step.action,
      id: step.id,
      label: step.label,
      ...(typeof step.expectedResult === "string" ? { expectedResult: step.expectedResult } : {}),
      ...(isSelector(step.selector) ? { selector: step.selector } : {}),
      ...(typeof step.text === "string" ? { text: step.text } : {}),
      ...(typeof step.timeoutMs === "number" ? { timeoutMs: step.timeoutMs } : {}),
    },
  ];
}

function isTestPlanAction(value: unknown): value is TestPlanAction {
  return (
    value === "launch" ||
    value === "tap" ||
    value === "input_text" ||
    value === "wait_for_text" ||
    value === "assert_text" ||
    value === "press_back" ||
    value === "screenshot" ||
    value === "collect_logcat"
  );
}

function isSelector(value: unknown): value is TestPlanSelector {
  if (!value || typeof value !== "object") {
    return false;
  }

  const selector = value as TestPlanSelector;
  return (
    (selector.by === "text" || selector.by === "resource-id" || selector.by === "content-desc") &&
    typeof selector.value === "string" &&
    (selector.match === undefined || selector.match === "exact" || selector.match === "contains")
  );
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
