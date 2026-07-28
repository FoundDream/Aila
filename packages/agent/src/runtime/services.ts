import type { ConversationRecord } from '../conversation-core'
import { createSkillToolPack, type LoadedSkill } from '../skills'
import { createExecutionModeToolPolicy, normalizeAilaExecutionMode } from '../tool-policy'
import {
  createDefaultToolRegistry,
  executeTool as executeRegisteredTool,
  type ToolContext,
  type ToolPack,
  type ToolRegistry,
} from '../tools'
import type { WorkbenchEvent } from '../workbench-events'
import type {
  RuntimeExecuteToolInput,
  RuntimeToolPackLoadInput,
  RuntimeWorkspaceResolverInput,
} from './api-types'
import {
  cloneRuntimeSettings,
  cloneRuntimeSkill,
  cloneRuntimeSkills,
  cloneRuntimeToolPack,
  cloneRuntimeToolPackLoadInput,
  cloneRuntimeToolRegistry,
  cloneRuntimeValue,
  cloneRuntimeWorkspaceRoots,
} from './clone'
import { createInMemoryRuntimeStore } from './memory-store'
import type { WorkbenchStore } from './repositories'
import { defaultCreateRuntimeId, defaultRuntimeNow, EMPTY_RUNTIME_SETTINGS } from './run-helpers'
import type { RuntimeToolContextInput } from './session-engine'
import { normalizeRuntimeHost, type WorkbenchHost, type WorkbenchOptions } from './workbench-host'

export function resolveStaticToolPacks(options: WorkbenchOptions): readonly ToolPack[] {
  return (options.host?.toolPacks ?? options.toolPacks ?? []).map(cloneRuntimeToolPack)
}

export function resolveStaticSkills(options: WorkbenchOptions): readonly LoadedSkill[] {
  return (options.host?.skills ?? options.skills ?? []).map(cloneRuntimeSkill)
}

export function createRuntimeSkillToolPacks(skills: readonly LoadedSkill[]): ToolPack[] {
  const pack = createSkillToolPack(skills)
  return pack ? [pack] : []
}

export class WorkbenchServices {
  readonly host: WorkbenchHost
  readonly store: WorkbenchStore
  readonly logger: Pick<Console, 'error' | 'warn'>
  readonly createId: () => string
  readonly createRunId: () => string
  readonly createEventId: () => string
  readonly now: () => number
  private readonly staticToolPacks: readonly ToolPack[]
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
    this.staticToolPacks = resolveStaticToolPacks(options)
    this.staticSkills = resolveStaticSkills(options)
    this.fallbackToolRegistry = createDefaultToolRegistry([
      ...this.staticToolPacks,
      ...createRuntimeSkillToolPacks(this.staticSkills),
    ])
  }

  emit(event: WorkbenchEvent): void {
    this.host.onEvent?.(cloneRuntimeValue(event))
  }

  async getToolRegistry(input?: RuntimeToolPackLoadInput): Promise<ToolRegistry> {
    if (!this.host.loadToolPacks && !this.host.loadSkills) {
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

  async reloadToolPacks(): Promise<ToolRegistry> {
    this.toolRegistryLoad = null
    this.skillsLoad = null
    return this.getToolRegistry()
  }

  async executeTool(input: RuntimeExecuteToolInput, record?: ConversationRecord): Promise<string> {
    const mode = normalizeAilaExecutionMode(input.mode)
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
        mode,
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
    const mode = normalizeAilaExecutionMode(input.mode)
    const onToolPolicy =
      mode === 'agent' && !this.host.onToolPolicy
        ? undefined
        : createExecutionModeToolPolicy(mode, this.host.onToolPolicy)
    return {
      settings: cloneRuntimeSettings((await this.host.loadSettings?.()) ?? EMPTY_RUNTIME_SETTINGS),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.messageId ? { messageId: input.messageId } : {}),
      ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      workspaceRoots: skillRoots.length > 0 ? [...(hostRoots ?? []), ...skillRoots] : hostRoots,
      shellCwd: this.resolveShellCwd(workspaceInput),
      ...(onToolPolicy ? { onToolPolicy } : {}),
      onToolApproval: this.host.onToolApproval,
      webSearch: this.host.webSearch,
      generateImage: this.host.generateImage,
      saveImage: this.host.saveImage,
      runShell: this.host.runShell,
      fileSystem: this.host.fileSystem,
      path: this.host.path,
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

  private async loadToolRegistry(input?: RuntimeToolPackLoadInput): Promise<ToolRegistry> {
    try {
      const loaded = await this.host.loadToolPacks?.(cloneRuntimeToolPackLoadInput(input))
      const skills = await this.getSkills()
      return createDefaultToolRegistry([
        ...this.staticToolPacks,
        ...(loaded ?? []).map(cloneRuntimeToolPack),
        ...createRuntimeSkillToolPacks(skills),
      ])
    } catch (error) {
      this.logger.warn(
        '[runtime] tool-pack load failed; continuing with built-in/static tools:',
        error,
      )
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
