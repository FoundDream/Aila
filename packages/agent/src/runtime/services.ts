import type { ConversationRecord, PersistedRunEvent } from '../conversation-core'
import { createSkillTool, type LoadedSkill } from '../skills'
import {
  createDefaultToolRegistry,
  executeTool as executeRegisteredTool,
  type ToolContext,
  type ToolRegistration,
  type ToolRegistry,
} from '../tools'
import type { WorkbenchEvent } from '../workbench-events'
import type {
  RuntimeExecuteToolInput,
  RuntimeToolLoadInput,
  RuntimeWorkspaceResolverInput,
} from './api-types'
import {
  cloneRuntimeSettings,
  cloneRuntimeSkill,
  cloneRuntimeSkills,
  cloneRuntimeTool,
  cloneRuntimeToolLoadInput,
  cloneRuntimeToolRegistry,
  cloneRuntimeValue,
  cloneRuntimeWorkspaceRoots,
} from './clone'
import { createInMemoryRuntimeStore } from './memory-store'
import type { WorkbenchStore } from './repositories'
import { defaultCreateRuntimeId, defaultRuntimeNow, EMPTY_RUNTIME_SETTINGS } from './run-helpers'
import type { RuntimeToolContextInput } from './session-engine'
import {
  normalizeRuntimeHost,
  type RuntimeLifecycleHooks,
  type WorkbenchHost,
  type WorkbenchOptions,
} from './workbench-host'

type LifecycleHookGroup = keyof RuntimeLifecycleHooks
type LifecycleHookHandlers<G extends LifecycleHookGroup> = NonNullable<RuntimeLifecycleHooks[G]>
type LifecycleHookPayload<
  G extends LifecycleHookGroup,
  N extends keyof LifecycleHookHandlers<G>,
> = LifecycleHookHandlers<G>[N] extends ((event: infer E) => void) | undefined ? E : never

/**
 * Maps turn/run/step run-event types onto lifecycle hooks. Tool and context
 * run events are excluded: their hooks fire from the live seams (tool policy
 * and approval wrappers, checkpoint persistence) and would double-fire here.
 */
const RUN_EVENT_HOOKS: Partial<
  Record<
    PersistedRunEvent['type'],
    | { group: 'turn'; name: 'onStarted' | 'onCompleted' | 'onFailed' | 'onAborted' }
    | {
        group: 'run'
        name: 'onStarted' | 'onPaused' | 'onResumed' | 'onCompleted' | 'onFailed' | 'onCancelled'
      }
    | { group: 'step'; name: 'onStarted' | 'onCompleted' | 'onFailed' | 'onCancelled' }
  >
> = {
  'turn.started': { group: 'turn', name: 'onStarted' },
  'turn.completed': { group: 'turn', name: 'onCompleted' },
  'turn.failed': { group: 'turn', name: 'onFailed' },
  'turn.cancelled': { group: 'turn', name: 'onAborted' },
  'turn.interrupted': { group: 'turn', name: 'onAborted' },
  'run.started': { group: 'run', name: 'onStarted' },
  'run.paused': { group: 'run', name: 'onPaused' },
  'run.resumed': { group: 'run', name: 'onResumed' },
  'run.completed': { group: 'run', name: 'onCompleted' },
  'run.failed': { group: 'run', name: 'onFailed' },
  'run.cancelled': { group: 'run', name: 'onCancelled' },
  'step.started': { group: 'step', name: 'onStarted' },
  'step.completed': { group: 'step', name: 'onCompleted' },
  'step.failed': { group: 'step', name: 'onFailed' },
  'step.cancelled': { group: 'step', name: 'onCancelled' },
}

/**
 * Fire-and-forget hook dispatch: never awaited, never throws into callers,
 * payloads cloned per delivery so hooks cannot mutate runtime state. Zero
 * cost when the hook is unregistered.
 */
export class LifecycleDispatcher {
  constructor(
    private readonly hooks: RuntimeLifecycleHooks | undefined,
    private readonly logger: Pick<Console, 'error' | 'warn'>,
  ) {}

  dispatch<G extends LifecycleHookGroup, N extends keyof LifecycleHookHandlers<G>>(
    group: G,
    name: N,
    payload: LifecycleHookPayload<G, N>,
  ): void {
    const handlers = this.hooks?.[group] as
      | Record<string, ((event: unknown) => void) | undefined>
      | undefined
    const handler = handlers?.[name as string]
    if (!handler) return
    try {
      handler(cloneRuntimeValue(payload))
    } catch (error) {
      this.logger.warn(`[lifecycle hook] ${group}.${String(name)} failed:`, error)
    }
  }

  dispatchFromRunEvent(conversationId: string, event: PersistedRunEvent): void {
    const target = RUN_EVENT_HOOKS[event.type]
    if (!target) return
    const payload = { conversationId, event }
    if (target.group === 'turn') this.dispatch('turn', target.name, payload)
    else if (target.group === 'run') this.dispatch('run', target.name, payload)
    else this.dispatch('step', target.name, payload)
  }
}

export function resolveStaticTools(options: WorkbenchOptions): readonly ToolRegistration[] {
  return (options.host?.tools ?? options.tools ?? []).map(cloneRuntimeTool)
}

export function resolveStaticSkills(options: WorkbenchOptions): readonly LoadedSkill[] {
  return (options.host?.skills ?? options.skills ?? []).map(cloneRuntimeSkill)
}

export function createRuntimeSkillTools(skills: readonly LoadedSkill[]): ToolRegistration[] {
  const tool = createSkillTool(skills)
  return tool ? [tool] : []
}

export class WorkbenchServices {
  readonly host: WorkbenchHost
  readonly store: WorkbenchStore
  readonly logger: Pick<Console, 'error' | 'warn'>
  readonly lifecycle: LifecycleDispatcher
  readonly createId: () => string
  readonly createRunId: () => string
  readonly createEventId: () => string
  readonly now: () => number
  private readonly staticTools: readonly ToolRegistration[]
  private readonly staticSkills: readonly LoadedSkill[]
  private readonly fallbackToolRegistry: ToolRegistry
  private toolRegistryLoad: Promise<ToolRegistry> | null = null
  private skillsLoad: Promise<readonly LoadedSkill[]> | null = null

  constructor(readonly options: WorkbenchOptions = {}) {
    this.host = normalizeRuntimeHost(options)
    this.createId = this.host.createId ?? defaultCreateRuntimeId
    this.createRunId = this.host.createRunId ?? defaultCreateRuntimeId
    this.createEventId = this.host.createEventId ?? defaultCreateRuntimeId
    this.now = this.host.now ?? defaultRuntimeNow
    this.store =
      options.store ??
      createInMemoryRuntimeStore({
        createId: this.createId,
        createEventId: this.createEventId,
        now: this.now,
      })
    this.logger = this.host.logger ?? console
    this.lifecycle = new LifecycleDispatcher(this.host.hooks, this.logger)
    this.staticTools = resolveStaticTools(options)
    this.staticSkills = resolveStaticSkills(options)
    this.fallbackToolRegistry = createDefaultToolRegistry([
      ...this.staticTools,
      ...createRuntimeSkillTools(this.staticSkills),
    ])
  }

  emit(event: WorkbenchEvent): void {
    this.host.onEvent?.(cloneRuntimeValue(event))
  }

  async getToolRegistry(input?: RuntimeToolLoadInput): Promise<ToolRegistry> {
    if (!this.host.loadTools && !this.host.loadSkills) {
      return cloneRuntimeToolRegistry(this.fallbackToolRegistry)
    }
    if (input) return cloneRuntimeToolRegistry(await this.loadToolRegistry(input))
    if (!this.toolRegistryLoad) this.toolRegistryLoad = this.loadToolRegistry()
    return cloneRuntimeToolRegistry(await this.toolRegistryLoad)
  }

  async getSkills(): Promise<LoadedSkill[]> {
    if (!this.host.loadSkills) return cloneRuntimeSkills(this.staticSkills)
    if (!this.skillsLoad) this.skillsLoad = this.loadSkills()
    return cloneRuntimeSkills(await this.skillsLoad)
  }

  async reloadTools(): Promise<ToolRegistry> {
    this.toolRegistryLoad = null
    this.skillsLoad = null
    return this.getToolRegistry()
  }

  async executeTool(input: RuntimeExecuteToolInput, record?: ConversationRecord): Promise<string> {
    const registry = await this.getToolRegistry(
      record && input.conversationId ? { conversationId: input.conversationId, record } : undefined,
    )
    return executeRegisteredTool(
      input.name,
      input.args,
      await this.buildToolContext({
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        ...(record ? { record } : {}),
        ...(input.messageId ? { messageId: input.messageId } : {}),
        ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      }),
      registry,
    )
  }

  async buildToolContext(input: RuntimeToolContextInput): Promise<ToolContext> {
    const workspaceInput = this.resolveWorkspaceInput(input)
    const hostRoots = this.resolveWorkspaceRoots(workspaceInput)
    const skillRoots = (await this.getSkills()).map((skill) => ({
      path: skill.directory,
      label: `Skill: ${skill.definition.name}`,
    }))
    const onToolPolicy =
      this.host.onToolPolicy && this.observeToolPolicy(this.host.onToolPolicy)
    return {
      settings: cloneRuntimeSettings((await this.host.loadSettings?.()) ?? EMPTY_RUNTIME_SETTINGS),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.messageId ? { messageId: input.messageId } : {}),
      ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      workspaceRoots: skillRoots.length > 0 ? [...(hostRoots ?? []), ...skillRoots] : hostRoots,
      shellCwd: this.resolveShellCwd(workspaceInput),
      ...(onToolPolicy ? { onToolPolicy } : {}),
      onToolApproval:
        this.host.onToolApproval && this.observeToolApproval(this.host.onToolApproval),
      webSearch: this.host.webSearch,
      generateImage: this.host.generateImage,
      saveImage: this.host.saveImage,
      runShell: this.host.runShell,
      fileSystem: this.host.fileSystem,
      path: this.host.path,
    }
  }

  /** Observational echo of policy decisions; never alters the evaluator's result. */
  private observeToolPolicy(
    evaluator: NonNullable<ToolContext['onToolPolicy']>,
  ): NonNullable<ToolContext['onToolPolicy']> {
    return (request) => {
      const result = evaluator(request)
      void Promise.resolve(result).then(
        (decision) =>
          this.lifecycle.dispatch('tool', 'onPolicy', { request, decision: decision ?? null }),
        () => {},
      )
      return result
    }
  }

  /** Observational echo of approval requests/resolutions around the host's approver. */
  private observeToolApproval(
    approve: NonNullable<ToolContext['onToolApproval']>,
  ): NonNullable<ToolContext['onToolApproval']> {
    return (request) => {
      this.lifecycle.dispatch('tool', 'onApprovalRequested', { request })
      const result = approve(request)
      void Promise.resolve(result).then(
        (approved) => this.lifecycle.dispatch('tool', 'onApprovalResolved', { request, approved }),
        () => {},
      )
      return result
    }
  }

  private resolveWorkspaceInput(input: RuntimeToolContextInput): RuntimeWorkspaceResolverInput {
    return {
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.record
        ? { workspace: cloneRuntimeValue(input.record.meta.workspace ?? null) }
        : {}),
    }
  }

  private resolveWorkspaceRoots(
    input: RuntimeWorkspaceResolverInput,
  ): ToolContext['workspaceRoots'] {
    const roots = this.host.workspaceRoots
    return cloneRuntimeWorkspaceRoots(
      typeof roots === 'function' ? roots(cloneRuntimeValue(input)) : roots,
    )
  }

  private resolveShellCwd(input: RuntimeWorkspaceResolverInput): ToolContext['shellCwd'] {
    const cwd = this.host.shellCwd
    return typeof cwd === 'function' ? cwd(cloneRuntimeValue(input)) : cwd
  }

  private async loadToolRegistry(input?: RuntimeToolLoadInput): Promise<ToolRegistry> {
    try {
      const loaded = await this.host.loadTools?.(cloneRuntimeToolLoadInput(input))
      const skills = await this.getSkills()
      return createDefaultToolRegistry([
        ...this.staticTools,
        ...(loaded ?? []).map(cloneRuntimeTool),
        ...createRuntimeSkillTools(skills),
      ])
    } catch (error) {
      this.logger.warn('[runtime] tool load failed; continuing with built-in/static tools:', error)
      return this.fallbackToolRegistry
    }
  }

  private async loadSkills(): Promise<readonly LoadedSkill[]> {
    try {
      const loaded = await this.host.loadSkills?.()
      return [...this.staticSkills, ...(loaded ?? [])].map(cloneRuntimeSkill)
    } catch (error) {
      this.logger.warn('[runtime] skill load failed; continuing without skills:', error)
      return cloneRuntimeSkills(this.staticSkills)
    }
  }
}
