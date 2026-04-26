import type { ThreadEvent, Usage } from "@openai/codex-sdk";

export type AgentRole =
  | "planner"
  | "component-worker"
  | "layout-worker"
  | "screen-worker"
  | "reviewer"
  | "verifier"
  | "merge-broker";

export type ModelTier = "spark" | "mini" | "gpt-5.5" | "program";

export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";

export type SandboxMode = "read-only" | "workspace-write";

export type ApprovalPolicy = "never" | "on-request" | "untrusted";

export interface NetworkPermission {
  shellNetwork: boolean;
  webSearch: boolean;
  mcpRead: boolean;
  mcpWrite: boolean;
}

export interface ProjectSpace {
  projectId: string;
  root: string;
}

export interface TaskScope {
  readablePaths?: string[];
  writablePaths?: string[];
  reportPaths?: string[];
  forbiddenPaths?: string[];
  network?: Partial<NetworkPermission>;
}

export interface RolePermissionProfile {
  role: AgentRole;
  modelTier: ModelTier;
  reasoningEffort?: ReasoningEffort;
  sandboxMode: SandboxMode;
  approvalPolicy: ApprovalPolicy;
  canWriteProjectRoot: boolean;
  defaultNetwork: NetworkPermission;
}

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface TaskContract {
  taskId: string;
  title: string;
  role: AgentRole;
  model: string;
  modelTier?: ModelTier;
  reasoningEffort?: ReasoningEffort;
  objective: string;
  readPaths: string[];
  writePaths: string[];
  forbiddenPaths: string[];
  dependencies: string[];
  acceptanceCriteria: string[];
  verificationCommands: string[];
  riskLevel: RiskLevel;
  expectedOutputs?: string[];
  notes?: string[];
}

export interface TaskDAGEdge {
  from: string;
  to: string;
  reason: string;
}

export interface TaskDAG {
  dagId: string;
  tasks: TaskContract[];
  edges: TaskDAGEdge[];
}

export interface ValidationIssue {
  code: string;
  message: string;
  taskId?: string;
  path?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  issues?: ValidationIssue[];
}

export type CommandStatus = "passed" | "failed" | "skipped";

export interface CommandRunResult {
  command: string;
  status: CommandStatus;
  outputSummary: string;
}

export interface VerificationResult {
  status: CommandStatus;
  commands: CommandRunResult[];
  summary: string;
}

export interface PatchApplyResult {
  status: "applied" | "failed";
  patchPath: string;
  changedFiles: string[];
  summary: string;
  errors: string[];
}

export interface MergeResult {
  taskId: string;
  status: "merged" | "failed" | "needs_changes";
  changedFiles: string[];
  patchPath?: string;
  summary: string;
  validation: ValidationResult;
  errors: string[];
}

export type TaskStatus =
  | "pending"
  | "ready"
  | "running"
  | "patch_generated"
  | "merge_pending"
  | "merged"
  | "verified"
  | "reviewing"
  | "needs_changes"
  | "passed"
  | "failed";

export interface OrchestrationResult {
  status: "pass" | "needs_changes" | "reject" | "failed";
  dag: TaskDAG;
  taskResults: import("../agents/worker.js").WorkerResult[];
  mergeResults: MergeResult[];
  verificationResults: VerificationResult[];
  reviewResults: import("../review/review-types.js").ReviewResult[];
  trace: ThreadRunTrace[];
  modelUsage: ModelUsageSummary;
  summary: string;
}

export interface ThreadRunTrace {
  runId: string;
  threadRunId: string;
  threadId?: string;
  taskId?: string;
  workerId?: string;
  role: AgentRole;
  model: string;
  reasoningEffort?: ReasoningEffort;
  status: "running" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  usage?: Usage | null;
  events: ThreadEvent[];
}

export interface ModelUsageStats {
  model: string;
  threadCount: number;
  turnCount: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface ModelUsageSummary {
  byModel: Record<string, ModelUsageStats>;
  totals: Omit<ModelUsageStats, "model">;
}

export type OrchestrationEventSink = (event: OrchestrationEvent) => void;

export interface ModelRunTelemetry {
  runId: string;
  threadRunId: string;
  threadId?: string;
  taskId?: string;
  workerId?: string;
  role: AgentRole;
  model: string;
  reasoningEffort?: ReasoningEffort;
  emit: OrchestrationEventSink;
}

interface OrchestrationEventBase {
  runId: string;
  timestamp: string;
}

export type OrchestrationEvent =
  | (OrchestrationEventBase & {
      type: "run.started";
      requirement: string;
      project: ProjectSpace;
    })
  | (OrchestrationEventBase & {
      type: "planner.started";
      model: string;
      reasoningEffort?: ReasoningEffort;
    })
  | (OrchestrationEventBase & {
      type: "planner.completed";
      dag: TaskDAG;
    })
  | (OrchestrationEventBase & {
      type: "planner.failed";
      error: string;
    })
  | (OrchestrationEventBase & {
      type: "task.started";
      task: TaskContract;
      workerId: string;
      threadRunId?: string;
    })
  | (OrchestrationEventBase & {
      type: "task.completed";
      task: TaskContract;
      workerId: string;
      threadRunId?: string;
      result?: import("../agents/worker.js").WorkerResult;
    })
  | (OrchestrationEventBase & {
      type: "task.failed";
      task: TaskContract;
      workerId: string;
      threadRunId?: string;
      error: string;
    })
  | (OrchestrationEventBase & {
      type: "merge.completed";
      task: TaskContract;
      result: MergeResult;
    })
  | (OrchestrationEventBase & {
      type: "verification.completed";
      result: VerificationResult;
    })
  | (OrchestrationEventBase & {
      type: "review.completed";
      task: TaskContract;
      result: import("../review/review-types.js").ReviewResult;
    })
  | (OrchestrationEventBase & {
      type: "thread.event";
      threadRunId: string;
      threadId?: string;
      taskId?: string;
      workerId?: string;
      role: AgentRole;
      model: string;
      reasoningEffort?: ReasoningEffort;
      sdkEvent: ThreadEvent;
    })
  | (OrchestrationEventBase & {
      type: "model.usage";
      threadRunId: string;
      threadId?: string;
      taskId?: string;
      workerId?: string;
      role: AgentRole;
      model: string;
      usage: Usage;
    })
  | (OrchestrationEventBase & {
      type: "run.completed";
      result: OrchestrationResult;
    })
  | (OrchestrationEventBase & {
      type: "run.failed";
      error: string;
      result: OrchestrationResult;
    });

export interface OrchestrationStream {
  events: AsyncIterable<OrchestrationEvent>;
  result: Promise<OrchestrationResult>;
}
