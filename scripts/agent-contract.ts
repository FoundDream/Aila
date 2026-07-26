import {
  Agent,
  type AgentEvent,
  type AgentModel,
  AgentRuntime,
  type AgentTool,
  type ChatMessage,
  type ModelCallResult,
} from '@aila/agent'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`)
  }
}

function completed(text: string, toolCalls: ModelCallResult['toolCalls'] = []): ModelCallResult {
  return {
    outcome: 'completed',
    text,
    reasoning: '',
    toolCalls,
    resolvedToolResults: [],
    stepUsage: [],
  }
}

async function testTextTurn(): Promise<void> {
  const events: AgentEvent[] = []
  const model: AgentModel = async (_input, sink) => {
    await sink?.({ type: 'text-delta', text: 'hello' })
    return completed('hello')
  }
  const agent = new Agent({ model })
  agent.subscribe((event) => {
    events.push(event)
  })

  const result = await agent.prompt('hi')
  assertEqual(result.status, 'completed', 'text agent should complete')
  assertEqual(result.turns, 1, 'text agent should use one turn')
  assertEqual(agent.state.messages.length, 2, 'text agent should retain user and assistant')
  assertEqual(agent.state.messages[1]?.role, 'assistant', 'text agent should append assistant')
  assert(
    events.some((event) => event.type === 'message_update'),
    'text agent should emit streaming updates',
  )
}

async function testToolTurn(): Promise<void> {
  const seenMessages: ChatMessage[][] = []
  let calls = 0
  const model: AgentModel = async (input) => {
    seenMessages.push(input.messages)
    calls += 1
    if (calls === 1) {
      return completed('', [
        {
          id: 'tool-1',
          name: 'echo',
          args: { value: 'ok' },
          argsJson: '{"value":"ok"}',
        },
      ])
    }
    return completed('done')
  }
  const tool: AgentTool = {
    definition: {
      name: 'echo',
      description: 'Echo a value.',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
    },
    execute(args) {
      return args.value
    },
  }
  const agent = new Agent({ model, tools: [tool] })
  const result = await agent.prompt('use the tool')

  assertEqual(result.status, 'completed', 'tool agent should complete')
  assertEqual(result.turns, 2, 'tool agent should continue after tool results')
  assertEqual(calls, 2, 'tool agent should call the model twice')
  assert(
    seenMessages[1]?.some((message) => message.role === 'tool' && message.content === 'ok'),
    'second turn should include the tool result',
  )
}

async function testSteerAndFollowUp(): Promise<void> {
  const promptsSeen: string[] = []
  let calls = 0
  const model: AgentModel = async (input) => {
    calls += 1
    promptsSeen.push(
      input.messages
        .filter(
          (message): message is Extract<ChatMessage, { role: 'user' }> => message.role === 'user',
        )
        .map((message) => (typeof message.content === 'string' ? message.content : ''))
        .join('|'),
    )
    if (calls === 1) {
      return completed('', [
        {
          id: 'tool-1',
          name: 'echo',
          args: {},
          argsJson: '{}',
        },
      ])
    }
    return completed(calls === 2 ? 'first done' : 'follow-up done')
  }
  const agent = new Agent({
    model,
    tools: [
      {
        definition: { name: 'echo', parameters: { type: 'object' } },
        execute: () => 'ok',
      },
    ],
  })
  agent.subscribe((event) => {
    if (event.type === 'tool_end') agent.steer('steered')
    if (
      event.type === 'message_end' &&
      event.message.role === 'assistant' &&
      event.message.content === 'first done'
    ) {
      agent.followUp('next')
    }
  })

  const result = await agent.prompt('start')
  assertEqual(result.status, 'completed', 'queued controls should complete')
  assertEqual(result.turns, 3, 'steer and follow-up should add turns')
  assert(promptsSeen[1]?.includes('steered'), 'steer should enter before the next model call')
  assert(promptsSeen[2]?.includes('next'), 'follow-up should start after the prior answer')
}

async function testAbort(): Promise<void> {
  const model: AgentModel = async (input) =>
    new Promise<ModelCallResult>((resolve) => {
      input.signal.addEventListener(
        'abort',
        () => {
          resolve({
            outcome: 'cancelled',
            text: '',
            reasoning: '',
            toolCalls: [],
            resolvedToolResults: [],
            stepUsage: [],
          })
        },
        { once: true },
      )
    })
  const agent = new Agent({ model })
  const running = agent.prompt('wait')
  agent.abort()
  const result = await running
  assertEqual(result.status, 'aborted', 'abort should cancel the active model call')
}

async function testIdleQueueAndReset(): Promise<void> {
  const model: AgentModel = async () => completed('done')
  const agent = new Agent({ model })
  agent.followUp('queued')
  assert(agent.hasQueuedMessages(), 'idle agents should accept queued follow-ups')
  await agent.prompt('start')
  assertEqual(agent.state.messages.length, 4, 'queued follow-up should run after the first answer')
  assert(!agent.hasQueuedMessages(), 'completed queues should drain')

  agent.steer('continue')
  await agent.continue()
  assertEqual(agent.state.messages.length, 6, 'continue should drain an idle queued message')
  agent.reset()
  assertEqual(agent.state.messages.length, 0, 'reset should clear the transcript')
}

async function testSharedRuntimeUsesIndividualToolSteps(): Promise<void> {
  const runtime = new AgentRuntime()
  const toolStepIds: string[] = []
  const executed: string[] = []
  let modelCalls = 0
  let preparations = 0

  const result = await runtime.run<{ id: string }>({
    identity: {
      conversationId: 'runtime-contract-conversation',
      turnId: 'runtime-contract-turn',
      runId: 'runtime-contract-run',
    },
    signal: new AbortController().signal,
    maxToolSteps: 2,
    prepareModelStep: () => {
      preparations += 1
    },
    executeModelStep: async () => {
      modelCalls += 1
      return {
        outcome: 'completed',
        toolCalls: modelCalls === 1 ? [{ id: 'first-tool' }, { id: 'second-tool' }] : [],
      }
    },
    executeToolStep: async ({ step, toolCall }) => {
      toolStepIds.push(`${step.toolCallId}:${step.kind}`)
      executed.push(toolCall.id)
      return { outcome: 'completed' }
    },
  })

  assertEqual(result.state.status, 'completed', 'shared runtime should complete')
  assertEqual(preparations, 2, 'shared runtime should prepare every model step')
  assertEqual(executed.join(','), 'first-tool,second-tool', 'shared runtime tool order')
  assertEqual(
    toolStepIds.join(','),
    'first-tool:tool,second-tool:tool',
    'each tool call should own a durable step identity',
  )
}

async function testSharedRuntimeCompactsAndRetriesOverflow(): Promise<void> {
  const runtime = new AgentRuntime()
  let modelCalls = 0
  let compactions = 0
  const result = await runtime.run<{ id: string }>({
    identity: {
      conversationId: 'overflow-contract-conversation',
      turnId: 'overflow-contract-turn',
      runId: 'overflow-contract-run',
    },
    signal: new AbortController().signal,
    maxToolSteps: 1,
    executeModelStep: async () => {
      modelCalls += 1
      return modelCalls === 1
        ? {
            outcome: 'failed',
            error: 'maximum context length exceeded',
            toolCalls: [],
            nextAction: { type: 'compact', reason: 'provider_overflow' },
          }
        : { outcome: 'completed', toolCalls: [] }
    },
    executeCompactStep: async () => {
      compactions += 1
      return { outcome: 'completed' }
    },
    executeToolStep: async () => ({ outcome: 'completed' }),
  })
  assertEqual(result.state.status, 'completed', 'overflow retry should complete')
  assertEqual(compactions, 1, 'overflow retry should compact exactly once')
  assertEqual(modelCalls, 2, 'overflow retry should call the model after compaction')
  assertEqual(
    result.state.steps.map((step) => `${step.kind}:${step.status}`).join(','),
    'model:failed,compact:completed,model:completed',
    'overflow retry should preserve inspectable step outcomes',
  )
}

await testTextTurn()
await testToolTurn()
await testSteerAndFollowUp()
await testAbort()
await testIdleQueueAndReset()
await testSharedRuntimeUsesIndividualToolSteps()
await testSharedRuntimeCompactsAndRetriesOverflow()

console.log('agent contract: ok')
