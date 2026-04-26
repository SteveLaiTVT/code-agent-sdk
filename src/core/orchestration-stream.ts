import type { ThreadEvent, Usage } from "@openai/codex-sdk";
import type {
  ModelRunTelemetry,
  ModelUsageStats,
  ModelUsageSummary,
  OrchestrationEvent,
  OrchestrationResult,
  ThreadRunTrace,
} from "./types.js";

export function emitThreadEvent(telemetry: ModelRunTelemetry | undefined, sdkEvent: ThreadEvent): void {
  if (!telemetry) {
    return;
  }

  if (sdkEvent.type === "thread.started") {
    telemetry.threadId = sdkEvent.thread_id;
  }
  const threadId = telemetry.threadId;
  telemetry.emit({
    type: "thread.event",
    runId: telemetry.runId,
    timestamp: new Date().toISOString(),
    threadRunId: telemetry.threadRunId,
    threadId,
    taskId: telemetry.taskId,
    workerId: telemetry.workerId,
    role: telemetry.role,
    model: telemetry.model,
    reasoningEffort: telemetry.reasoningEffort,
    sdkEvent,
  });

  if (sdkEvent.type === "turn.completed") {
    telemetry.emit({
      type: "model.usage",
      runId: telemetry.runId,
      timestamp: new Date().toISOString(),
      threadRunId: telemetry.threadRunId,
      threadId,
      taskId: telemetry.taskId,
      workerId: telemetry.workerId,
      role: telemetry.role,
      model: telemetry.model,
      usage: sdkEvent.usage,
    });
  }
}

export async function collectOrchestrationStream(
  events: AsyncIterable<OrchestrationEvent>
): Promise<OrchestrationResult> {
  let finalResult: OrchestrationResult | undefined;
  let failure: OrchestrationResult | undefined;

  for await (const event of events) {
    if (event.type === "run.completed") {
      finalResult = event.result;
    }
    if (event.type === "run.failed") {
      failure = event.result;
    }
  }

  if (finalResult) {
    return finalResult;
  }
  if (failure) {
    return failure;
  }
  throw new Error("Orchestration stream ended before a run.completed or run.failed event.");
}

export function buildThreadRunTrace(events: Iterable<OrchestrationEvent>): ThreadRunTrace[] {
  const traces = new Map<string, ThreadRunTrace>();

  for (const event of events) {
    if (event.type !== "thread.event") {
      continue;
    }

    const existing = traces.get(event.threadRunId);
    const trace =
      existing ??
      {
        runId: event.runId,
        threadRunId: event.threadRunId,
        threadId: event.threadId,
        taskId: event.taskId,
        workerId: event.workerId,
        role: event.role,
        model: event.model,
        reasoningEffort: event.reasoningEffort,
        status: "running" as const,
        startedAt: event.timestamp,
        usage: null,
        events: [],
      };

    if (event.threadId) {
      trace.threadId = event.threadId;
    }
    if (event.sdkEvent.type === "thread.started") {
      trace.threadId = event.sdkEvent.thread_id;
    }
    if (event.sdkEvent.type === "turn.completed") {
      trace.status = "completed";
      trace.completedAt = event.timestamp;
      trace.usage = addUsage(trace.usage, event.sdkEvent.usage);
    }
    if (event.sdkEvent.type === "turn.failed" || event.sdkEvent.type === "error") {
      trace.status = "failed";
      trace.completedAt = event.timestamp;
    }

    trace.events.push(event.sdkEvent);
    traces.set(event.threadRunId, trace);
  }

  return [...traces.values()];
}

export function summarizeModelUsage(
  traceOrEvents: Iterable<ThreadRunTrace> | Iterable<OrchestrationEvent>
): ModelUsageSummary {
  const values = [...traceOrEvents];
  const traces = values.every(isThreadRunTrace)
    ? (values as ThreadRunTrace[])
    : buildThreadRunTrace(values as OrchestrationEvent[]);
  const byModel: Record<string, ModelUsageStats> = {};
  const totals = emptyStats("__total__");

  for (const trace of traces) {
    const stats = (byModel[trace.model] ??= emptyStats(trace.model));
    stats.threadCount += 1;
    totals.threadCount += 1;

    for (const event of trace.events) {
      if (event.type !== "turn.completed") {
        continue;
      }
      addUsageToStats(stats, event.usage);
      addUsageToStats(totals, event.usage);
    }
  }

  return {
    byModel,
    totals: {
      threadCount: totals.threadCount,
      turnCount: totals.turnCount,
      inputTokens: totals.inputTokens,
      cachedInputTokens: totals.cachedInputTokens,
      outputTokens: totals.outputTokens,
      reasoningOutputTokens: totals.reasoningOutputTokens,
    },
  };
}

function isThreadRunTrace(value: ThreadRunTrace | OrchestrationEvent): value is ThreadRunTrace {
  return "threadRunId" in value && "events" in value && Array.isArray(value.events);
}

function emptyStats(model: string): ModelUsageStats {
  return {
    model,
    threadCount: 0,
    turnCount: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };
}

function addUsage(current: Usage | null | undefined, next: Usage): Usage {
  if (!current) {
    return { ...next };
  }
  return {
    input_tokens: current.input_tokens + next.input_tokens,
    cached_input_tokens: current.cached_input_tokens + next.cached_input_tokens,
    output_tokens: current.output_tokens + next.output_tokens,
    reasoning_output_tokens: current.reasoning_output_tokens + next.reasoning_output_tokens,
  };
}

function addUsageToStats(stats: ModelUsageStats, usage: Usage): void {
  stats.turnCount += 1;
  stats.inputTokens += usage.input_tokens;
  stats.cachedInputTokens += usage.cached_input_tokens;
  stats.outputTokens += usage.output_tokens;
  stats.reasoningOutputTokens += usage.reasoning_output_tokens;
}
