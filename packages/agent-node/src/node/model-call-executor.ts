import type {
  ModelCallExecutor,
  ModelCallInput,
  ModelCallResult,
  ModelCallToolCall,
} from '@aila/agent'
import type { ModelStreamClient } from './model-stream'

export interface ProviderModelCallExecutorOptions {
  modelStreamClient: ModelStreamClient
}

/**
 * Adapts one ModelStreamClient invocation into the platform-neutral
 * ModelCallExecutor contract. Tool handlers are deliberately absent.
 */
export function createProviderModelCallExecutor(
  options: ProviderModelCallExecutorOptions,
): ModelCallExecutor {
  return {
    async execute(input, sink): Promise<ModelCallResult> {
      const text: string[] = []
      const reasoning: string[] = []
      const toolCalls: ModelCallToolCall[] = []
      const resolvedToolResults: ModelCallResult['resolvedToolResults'] = []
      const stepUsage: ModelCallResult['stepUsage'] = []
      let totalUsage: ModelCallResult['totalUsage']
      let responseMessages: ModelCallResult['responseMessages']

      try {
        const stream = options.modelStreamClient.stream(toModelStreamInput(input))
        for await (const event of stream) {
          await sink?.(event)
          switch (event.type) {
            case 'text-delta':
              text.push(event.text)
              break
            case 'reasoning-delta':
              reasoning.push(event.text)
              break
            case 'tool-call':
              toolCalls.push(parseToolCall(event.toolCallId, event.toolName, event.input))
              break
            case 'tool-result':
              resolvedToolResults.push({
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                output: event.output,
              })
              break
            case 'tool-error':
              resolvedToolResults.push({
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                error: errorMessage(event.error),
              })
              break
            case 'finish-step':
              if (event.usage) stepUsage.push(structuredClone(event.usage))
              break
            case 'finish':
              if (event.totalUsage) totalUsage = structuredClone(event.totalUsage)
              break
            case 'response-messages':
              responseMessages = structuredClone(event.messages)
              break
            case 'abort':
              return result('cancelled', 'abort_signal')
            case 'error':
              return result('failed', errorMessage(event.error))
            case 'tool-input-start':
            case 'tool-input-delta':
              break
          }
        }
        return result('completed')
      } catch (error) {
        return result(input.signal.aborted ? 'cancelled' : 'failed', errorMessage(error))
      }

      function result(outcome: ModelCallResult['outcome'], error?: string): ModelCallResult {
        return {
          outcome,
          text: text.join(''),
          reasoning: reasoning.join(''),
          toolCalls: structuredClone(toolCalls),
          resolvedToolResults: structuredClone(resolvedToolResults),
          stepUsage: structuredClone(stepUsage),
          ...(totalUsage ? { totalUsage: structuredClone(totalUsage) } : {}),
          ...(responseMessages ? { responseMessages: structuredClone(responseMessages) } : {}),
          ...(error ? { error } : {}),
        }
      }
    },
  }
}

function toModelStreamInput(input: ModelCallInput): Parameters<ModelStreamClient['stream']>[0] {
  return {
    descriptor: structuredClone(input.descriptor),
    apiKey: input.apiKey,
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    messages: structuredClone(input.messages),
    ...(input.contextPlan ? { contextPlan: structuredClone(input.contextPlan) } : {}),
    ...(input.cache ? { cache: structuredClone(input.cache) } : {}),
    tools: structuredClone(input.tools),
    signal: input.signal,
    ...(input.stepIndex !== undefined ? { step: input.stepIndex } : {}),
    ...(input.requireImages !== undefined ? { requireImages: input.requireImages } : {}),
  }
}

function parseToolCall(id: string, name: string, input: unknown): ModelCallToolCall {
  const args =
    input && typeof input === 'object' && !Array.isArray(input)
      ? structuredClone(input as Record<string, unknown>)
      : {}
  return {
    id,
    name,
    args,
    argsJson: JSON.stringify(args),
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
