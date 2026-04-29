import {
  Codex,
  type CodexOptions,
  type ModelReasoningEffort,
  type SandboxMode,
  type ThreadEvent,
  type ThreadItem,
  type ThreadOptions,
  type Usage,
  type WebSearchMode,
} from "@openai/codex-sdk";
import { createCodexClientOptions } from "./common/codex-env.js";

export type TaskSessionUsage = {
  cachedInputTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

export type TaskSessionStatusPhase = "started" | "updated" | "completed";

export type TaskSessionStreamEvent =
  | {
      type: "thread";
      threadId: string;
    }
  | {
      type: "message";
      text: string;
      done: boolean;
    }
  | {
      type: "status";
      label: string;
      kind: string;
      phase: TaskSessionStatusPhase;
    }
  | {
      type: "usage";
      usage: TaskSessionUsage;
    }
  | {
      type: "thread.event";
      event: ThreadEvent;
    }
  | {
      type: "error";
      message: string;
    };

type CodexThreadDriver = {
  runStreamed(message: string): Promise<{ events: AsyncIterable<ThreadEvent> }>;
};

type CodexClientDriver = {
  startThread(options?: ThreadOptions): CodexThreadDriver;
  resumeThread(id: string, options?: ThreadOptions): CodexThreadDriver;
};

export type RunTaskSessionStreamedInput = {
  /** Message sent to the Codex thread. */
  message: string;
  /** Existing thread id to resume. Omit to start a new thread. */
  threadId?: string | null;
  /** Working directory passed to the Codex thread. */
  workingDirectory?: string;
  /** True to forward raw Codex SDK thread events as thread.event items. */
  emitThreadEvents?: boolean;
  /** Direct Codex client options. Values here override environment-derived options. */
  codexOptions?: CodexOptions;
  /** Direct Codex thread options. Specific top-level fields below override this object. */
  threadOptions?: ThreadOptions;
  approvalPolicy?: ThreadOptions["approvalPolicy"];
  model?: string;
  modelReasoningEffort?: ModelReasoningEffort;
  networkAccessEnabled?: boolean;
  sandboxMode?: SandboxMode;
  skipGitRepoCheck?: boolean;
  webSearchMode?: WebSearchMode;
  webSearchEnabled?: boolean;
};

export type RunTaskSessionStreamedOptions = {
  codex?: CodexClientDriver;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export async function* runTaskSessionStreamed(
  input: RunTaskSessionStreamedInput,
  options: RunTaskSessionStreamedOptions = {},
): AsyncGenerator<TaskSessionStreamEvent> {
  try {
    const codex =
      options.codex ??
      new Codex({
        ...createCodexClientOptions({
          cwd: options.cwd,
          env: options.env,
        }),
        ...input.codexOptions,
      });
    const threadOptions = buildThreadOptions(input);
    const thread = input.threadId
      ? codex.resumeThread(input.threadId, threadOptions)
      : codex.startThread(threadOptions);
    const streamed = await thread.runStreamed(input.message);

    for await (const event of streamed.events) {
      if (input.emitThreadEvents) {
        yield {
          type: "thread.event",
          event,
        };
      }

      if (event.type === "thread.started") {
        yield {
          type: "thread",
          threadId: event.thread_id,
        };
        continue;
      }

      if (
        event.type === "item.started" ||
        event.type === "item.updated" ||
        event.type === "item.completed"
      ) {
        const item = event.item;

        if (item.type === "agent_message") {
          yield {
            type: "message",
            done: event.type === "item.completed",
            text: item.text,
          };
          continue;
        }

        yield {
          type: "status",
          kind: item.type,
          label: createStatusLabel(item),
          phase: mapPhase(event.type),
        };
        continue;
      }

      if (event.type === "turn.completed") {
        yield {
          type: "usage",
          usage: mapUsage(event.usage),
        };
        continue;
      }

      if (event.type === "turn.failed") {
        yield {
          type: "error",
          message: event.error.message,
        };
        return;
      }

      if (event.type === "error") {
        yield {
          type: "error",
          message: event.message,
        };
        return;
      }
    }
  } catch (error) {
    yield {
      type: "error",
      message: error instanceof Error ? error.message : "Unknown task session error.",
    };
  }
}

function buildThreadOptions(input: RunTaskSessionStreamedInput): ThreadOptions {
  return {
    ...input.threadOptions,
    ...(input.approvalPolicy ? { approvalPolicy: input.approvalPolicy } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.modelReasoningEffort ? { modelReasoningEffort: input.modelReasoningEffort } : {}),
    ...(input.networkAccessEnabled === undefined
      ? {}
      : { networkAccessEnabled: input.networkAccessEnabled }),
    ...(input.sandboxMode ? { sandboxMode: input.sandboxMode } : {}),
    ...(input.skipGitRepoCheck === undefined ? {} : { skipGitRepoCheck: input.skipGitRepoCheck }),
    ...(input.webSearchMode ? { webSearchMode: input.webSearchMode } : {}),
    ...(input.webSearchEnabled === undefined ? {} : { webSearchEnabled: input.webSearchEnabled }),
    ...(input.workingDirectory ? { workingDirectory: input.workingDirectory } : {}),
  };
}

function createStatusLabel(item: ThreadItem) {
  switch (item.type) {
    case "reasoning":
      return item.text;
    case "command_execution":
      return item.command;
    case "file_change":
      return item.changes.map((change) => `${change.kind}:${change.path}`).join(", ");
    case "mcp_tool_call":
      return `${item.server}.${item.tool}`;
    case "web_search":
      return item.query;
    case "todo_list":
      return item.items.map((todo) => todo.text).join(" | ");
    case "error":
      return item.message;
    default:
      return item.type;
  }
}

function mapPhase(eventType: ThreadEvent["type"]): TaskSessionStatusPhase {
  if (eventType === "item.started") {
    return "started";
  }
  if (eventType === "item.completed") {
    return "completed";
  }
  return "updated";
}

function mapUsage(usage: Usage): TaskSessionUsage {
  return {
    cachedInputTokens: usage.cached_input_tokens,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    reasoningOutputTokens: usage.reasoning_output_tokens,
  };
}
