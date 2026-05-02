/**
 * Agent loop backed by Vercel AI SDK + OpenRouter provider.
 *
 * streamText handles SSE parsing, tool_call delta accumulation, and the
 * multi-step tool loop (via stopWhen). We translate fullStream events to
 * the IPC handler contract that the renderer already speaks.
 */

import {
  jsonSchema,
  stepCountIs,
  streamText,
  tool,
  type ModelMessage,
} from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { executeTool, TOOL_DEFINITIONS } from "./tools";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolCallEvent {
  id: string;
  name: string;
  arguments: string;
}

export interface ToolResultEvent {
  id: string;
  result: string;
  isError: boolean;
}

export interface UsageInfo {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface StreamHandlers {
  onTextDelta: (delta: string) => void;
  onReasoningDelta: (delta: string) => void;
  onToolCallStart: (event: ToolCallEvent) => void;
  onToolCallResult: (event: ToolResultEvent) => void;
  onDone: (full: {
    text: string;
    reasoning: string;
    usage?: UsageInfo;
  }) => void;
  onError: (message: string) => void;
}

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const MAX_STEPS = 10;

export interface ModelInfo {
  model: string;
  contextLength: number | null;
}

const contextLengthCache = new Map<string, number | null>();

interface OpenRouterModelEntry {
  id: string;
  context_length?: number | null;
}

async function fetchContextLength(model: string): Promise<number | null> {
  if (contextLengthCache.has(model))
    return contextLengthCache.get(model) ?? null;
  try {
    const response = await fetch(OPENROUTER_MODELS_URL);
    if (!response.ok) {
      contextLengthCache.set(model, null);
      return null;
    }
    const json = (await response.json()) as { data?: OpenRouterModelEntry[] };
    const entry = json.data?.find((m) => m.id === model);
    const length =
      typeof entry?.context_length === "number" ? entry.context_length : null;
    contextLengthCache.set(model, length);
    return length;
  } catch {
    contextLengthCache.set(model, null);
    return null;
  }
}

export async function getModelInfo(): Promise<ModelInfo> {
  const model = process.env.OPENROUTER_MODEL || "deepseek/deepseek-chat-v3.1";
  const contextLength = await fetchContextLength(model);
  return { model, contextLength };
}

// Build AI SDK tool set from TOOL_DEFINITIONS. Keep JSON Schema (no zod
// migration), wrap executeTool as the per-tool execute callback.
const aiTools = Object.fromEntries(
  TOOL_DEFINITIONS.map((td) => [
    td.function.name,
    tool({
      description: td.function.description,
      inputSchema: jsonSchema(
        td.function.parameters as Parameters<typeof jsonSchema>[0],
      ),
      execute: async (args) =>
        executeTool(td.function.name, args as Record<string, unknown>),
    }),
  ]),
);

// Convert renderer's OpenAI-format ChatMessage[] to AI SDK ModelMessage[].
// Tool messages need toolName; we look it up from the previous assistant's
// tool_calls list since the renderer only persists tool_call_id + content.
function toModelMessages(messages: ChatMessage[]): ModelMessage[] {
  const toolNameById = new Map<string, string>();
  const out: ModelMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "system" || msg.role === "user") {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }

    if (msg.role === "assistant") {
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        out.push({ role: "assistant", content: msg.content });
        continue;
      }
      const parts: Array<
        | { type: "text"; text: string }
        | {
            type: "tool-call";
            toolCallId: string;
            toolName: string;
            input: unknown;
          }
      > = [];
      if (msg.content) parts.push({ type: "text", text: msg.content });
      for (const tc of msg.tool_calls) {
        toolNameById.set(tc.id, tc.function.name);
        let input: unknown = {};
        try {
          input = tc.function.arguments
            ? JSON.parse(tc.function.arguments)
            : {};
        } catch {
          input = {};
        }
        parts.push({
          type: "tool-call",
          toolCallId: tc.id,
          toolName: tc.function.name,
          input,
        });
      }
      out.push({ role: "assistant", content: parts });
      continue;
    }

    if (msg.role === "tool") {
      const toolName = toolNameById.get(msg.tool_call_id) ?? "unknown";
      out.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: msg.tool_call_id,
            toolName,
            output: { type: "text", value: msg.content },
          },
        ],
      });
    }
  }

  return out;
}

export async function streamChat(
  initialMessages: ChatMessage[],
  signal: AbortSignal,
  handlers: StreamHandlers,
): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    handlers.onError(
      "OPENROUTER_API_KEY is not set. Add it to .env and restart the app.",
    );
    return;
  }
  const model = process.env.OPENROUTER_MODEL || "deepseek/deepseek-chat-v3.1";
  const appName = process.env.OPENROUTER_APP_NAME || "Aila";

  const openrouter = createOpenRouter({ apiKey, appName });

  let aggregateText = "";
  let aggregateReasoning = "";
  let lastUsage: UsageInfo | null = null;

  try {
    const result = streamText({
      model: openrouter(model, { usage: { include: true } }),
      messages: toModelMessages(initialMessages),
      tools: aiTools,
      stopWhen: stepCountIs(MAX_STEPS),
      abortSignal: signal,
    });

    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-delta":
          aggregateText += part.text;
          handlers.onTextDelta(part.text);
          break;
        case "reasoning-delta":
          aggregateReasoning += part.text;
          handlers.onReasoningDelta(part.text);
          break;
        case "tool-call":
          handlers.onToolCallStart({
            id: part.toolCallId,
            name: part.toolName,
            arguments: JSON.stringify(part.input ?? {}),
          });
          break;
        case "tool-result": {
          const out = part.output;
          const result =
            typeof out === "string"
              ? out
              : out == null
                ? ""
                : JSON.stringify(out);
          handlers.onToolCallResult({
            id: part.toolCallId,
            result,
            isError: false,
          });
          break;
        }
        case "tool-error": {
          const message =
            part.error instanceof Error
              ? part.error.message
              : String(part.error);
          handlers.onToolCallResult({
            id: part.toolCallId,
            result: message,
            isError: true,
          });
          break;
        }
        case "finish-step": {
          const u = part.usage;
          if (u) {
            lastUsage = {
              promptTokens: u.inputTokens ?? 0,
              completionTokens: u.outputTokens ?? 0,
              totalTokens:
                u.totalTokens ?? (u.inputTokens ?? 0) + (u.outputTokens ?? 0),
            };
          }
          break;
        }
        case "finish": {
          const u = part.totalUsage;
          if (u) {
            lastUsage = {
              promptTokens: u.inputTokens ?? 0,
              completionTokens: u.outputTokens ?? 0,
              totalTokens:
                u.totalTokens ?? (u.inputTokens ?? 0) + (u.outputTokens ?? 0),
            };
          }
          break;
        }
        case "abort":
          handlers.onDone({
            text: aggregateText,
            reasoning: aggregateReasoning,
            usage: lastUsage ?? undefined,
          });
          return;
        case "error": {
          const message =
            part.error instanceof Error
              ? part.error.message
              : String(part.error);
          handlers.onError(message);
          return;
        }
      }
    }

    handlers.onDone({
      text: aggregateText,
      reasoning: aggregateReasoning,
      usage: lastUsage ?? undefined,
    });
  } catch (error) {
    if (signal.aborted) {
      handlers.onDone({
        text: aggregateText,
        reasoning: aggregateReasoning,
        usage: lastUsage ?? undefined,
      });
      return;
    }
    handlers.onError(error instanceof Error ? error.message : String(error));
  }
}
