import type { ChatMessage, RunEvent } from '../agent-protocol'
import {
  AILA_PLAN_ARTIFACT_SCHEMA_VERSION,
  AILA_PLAN_REVISION_SCHEMA_VERSION,
  normalizePlanArtifact,
  normalizePlanRevision,
  PLAN_DRIFT_SEVERITIES,
  PLAN_STATUSES,
  type PlanArtifact,
  type PlanDriftSeverity,
  type PlanQuestion,
  type PlanStatus,
  type PlanTaskStatus,
} from '../plan-core'
import type { ToolPack } from '../tools'
import type { PlanRepository } from './repositories'

interface PlanLifecycleEventInput {
  plan: PlanArtifact
  messageId: string
  data?: Record<string, unknown>
}

export interface PlanToolServices {
  store: PlanRepository
  createId: () => string
  now: () => number
  recordLifecycleEvent: (type: RunEvent['type'], input: PlanLifecycleEventInput) => Promise<void>
}

export interface CreatePlanToolPackInput {
  conversationId: string
  assistantMessageId: string
  sourceUserMessageId: string
}

export interface CreatePlanImplementationToolPackInput {
  conversationId: string
  assistantMessageId: string
  planId: string
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`plan tool argument "${key}" must be a non-empty string`)
  }
  return value.trim()
}

function optionalStringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function arrayArg(args: Record<string, unknown>, key: string): unknown[] {
  const value = args[key]
  return Array.isArray(value) ? value : []
}

function planStatusArg(
  args: Record<string, unknown>,
  key: string,
  fallback: PlanStatus,
): PlanStatus {
  const value = args[key]
  return typeof value === 'string' && PLAN_STATUSES.includes(value as PlanStatus)
    ? (value as PlanStatus)
    : fallback
}

function planDriftSeverityArg(
  args: Record<string, unknown>,
  key: string,
  fallback: PlanDriftSeverity,
): PlanDriftSeverity {
  const value = args[key]
  return typeof value === 'string' && PLAN_DRIFT_SEVERITIES.includes(value as PlanDriftSeverity)
    ? (value as PlanDriftSeverity)
    : fallback
}

function updatePlanTaskStatus(
  plan: PlanArtifact,
  taskId: string,
  status: PlanTaskStatus,
): PlanArtifact {
  let found = false
  const tasks = plan.tasks.map((task) => {
    if (task.id !== taskId) return task
    found = true
    return { ...task, status }
  })
  if (!found) throw new Error(`plan task not found: ${taskId}`)
  return { ...plan, tasks }
}

function planToolMetadata(name: string) {
  return {
    name,
    readOnly: true,
    destructive: false,
    requiresApproval: false,
    access: [],
    scope: [],
    planSafe: true,
  }
}

function requirePlanMethod<K extends keyof PlanRepository>(
  store: PlanRepository,
  method: K,
): NonNullable<PlanRepository[K]> {
  const fn = store[method]
  if (!fn) throw new Error(`runtime store cannot ${String(method)}`)
  return fn as NonNullable<PlanRepository[K]>
}

export function renderPlanContext(
  plan: PlanArtifact,
  operation: 'revise' | 'implement',
): ChatMessage {
  const taskLines = plan.tasks.map((task) => {
    const status = task.status.replaceAll('_', ' ')
    return `- [${status}] ${task.id}: ${task.title}`
  })
  const verificationLines = plan.verification.map((entry) => `- ${entry}`)
  const fileLines = plan.files.map(
    (file) => `- ${file.path}${file.kind ? ` (${file.kind})` : ''}: ${file.reason}`,
  )
  return {
    role: 'system',
    content: [
      operation === 'implement'
        ? 'Approved Aila plan context. Implement this approved plan. Do not silently change task scope; record drift when material changes are discovered.'
        : 'Aila plan context. Revise this plan and keep the plan artifact in sync.',
      '',
      `Plan ID: ${plan.id}`,
      `Title: ${plan.title}`,
      `Status: ${plan.status}`,
      `Approved revision: ${plan.approvedRevisionId ?? plan.latestRevisionId ?? 'none'}`,
      '',
      'Markdown:',
      plan.markdown,
      '',
      taskLines.length > 0 ? 'Tasks:' : '',
      ...taskLines,
      verificationLines.length > 0 ? 'Verification:' : '',
      ...verificationLines,
      fileLines.length > 0 ? 'Affected files:' : '',
      ...fileLines,
    ]
      .filter((line) => line.length > 0)
      .join('\n'),
  }
}

export function createPlanToolPack(
  services: PlanToolServices,
  input: CreatePlanToolPackInput,
): ToolPack {
  const { conversationId, assistantMessageId, sourceUserMessageId } = input
  const recordPlanEvent = (
    type: RunEvent['type'],
    plan: PlanArtifact,
    data: Record<string, unknown> = {},
  ) => services.recordLifecycleEvent(type, { plan, messageId: assistantMessageId, data })

  return {
    id: 'aila-plan-tools',
    name: 'Aila Plan Tools',
    description: 'Create and revise first-class Aila plan artifacts.',
    tools: [
      {
        spec: {
          type: 'function',
          function: {
            name: 'plan_create',
            description:
              'Create a first-class plan artifact for the current conversation. Use this in Plan mode after exploration.',
            parameters: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Stable plan id.' },
                revisionId: { type: 'string', description: 'Optional initial revision id.' },
                title: { type: 'string', description: 'Short plan title.' },
                status: {
                  type: 'string',
                  enum: ['draft', 'needs_input', 'ready'],
                  description: 'Initial plan status. Defaults to draft.',
                },
                markdown: { type: 'string', description: 'User-reviewable Markdown plan.' },
                tasks: { type: 'array', items: { type: 'object' } },
                questions: { type: 'array', items: { type: 'object' } },
                assumptions: { type: 'array', items: { type: 'string' } },
                risks: { type: 'array', items: { type: 'string' } },
                files: { type: 'array', items: { type: 'object' } },
                verification: { type: 'array', items: { type: 'string' } },
              },
              required: ['id', 'title', 'markdown'],
              additionalProperties: false,
            },
          },
          metadata: planToolMetadata('plan_create'),
        },
        run: async (args) => {
          const createPlan = requirePlanMethod(services.store, 'createPlan')
          const planId = stringArg(args, 'id')
          const title = stringArg(args, 'title')
          const markdown = stringArg(args, 'markdown')
          const createdAt = services.now()
          const revision = normalizePlanRevision({
            schemaVersion: AILA_PLAN_REVISION_SCHEMA_VERSION,
            id: optionalStringArg(args, 'revisionId') ?? services.createId(),
            planId,
            createdAt,
            author: 'assistant',
            markdown,
            tasks: arrayArg(args, 'tasks'),
          })
          if (!revision) throw new Error('plan_create received an invalid revision')
          const plan = normalizePlanArtifact(
            {
              schemaVersion: AILA_PLAN_ARTIFACT_SCHEMA_VERSION,
              id: planId,
              conversationId,
              sourceUserMessageId,
              latestAssistantMessageId: assistantMessageId,
              title,
              status: planStatusArg(args, 'status', 'draft'),
              markdown,
              tasks: revision.tasks,
              questions: arrayArg(args, 'questions'),
              assumptions: arrayArg(args, 'assumptions'),
              risks: arrayArg(args, 'risks'),
              files: arrayArg(args, 'files'),
              verification: arrayArg(args, 'verification'),
              drift: [],
              revisions: [revision],
              latestRevisionId: revision.id,
              createdAt,
              updatedAt: createdAt,
            },
            conversationId,
          )
          if (!plan) throw new Error('plan_create received an invalid plan artifact')
          const created = await createPlan(plan)
          await recordPlanEvent('plan.updated', created, { summary: 'Plan created' })
          if (created.status === 'ready') await recordPlanEvent('plan.ready', created)
          return JSON.stringify({ ok: true, planId: created.id, status: created.status })
        },
      },
      {
        spec: {
          type: 'function',
          function: {
            name: 'plan_update',
            description: 'Append a new revision to an existing plan artifact.',
            parameters: {
              type: 'object',
              properties: {
                planId: { type: 'string' },
                revisionId: { type: 'string' },
                title: { type: 'string' },
                status: { type: 'string', enum: PLAN_STATUSES },
                markdown: { type: 'string' },
                tasks: { type: 'array', items: { type: 'object' } },
                summary: { type: 'string' },
              },
              required: ['planId', 'markdown'],
              additionalProperties: false,
            },
          },
          metadata: planToolMetadata('plan_update'),
        },
        run: async (args) => {
          const getPlan = requirePlanMethod(services.store, 'getPlan')
          const appendPlanRevision = requirePlanMethod(services.store, 'appendPlanRevision')
          const updatePlan = requirePlanMethod(services.store, 'updatePlan')
          const planId = stringArg(args, 'planId')
          const current = await getPlan(conversationId, planId)
          const markdown = stringArg(args, 'markdown')
          const createdAt = services.now()
          const revision = normalizePlanRevision({
            schemaVersion: AILA_PLAN_REVISION_SCHEMA_VERSION,
            id: optionalStringArg(args, 'revisionId') ?? services.createId(),
            planId,
            createdAt,
            author: 'assistant',
            markdown,
            tasks: arrayArg(args, 'tasks').length > 0 ? arrayArg(args, 'tasks') : current.tasks,
            summary: optionalStringArg(args, 'summary'),
          })
          if (!revision) throw new Error('plan_update received an invalid revision')
          const revised = await appendPlanRevision({ conversationId, planId, revision })
          const updated = await updatePlan({
            ...revised,
            title: optionalStringArg(args, 'title') ?? revised.title,
            status: planStatusArg(args, 'status', revised.status),
            updatedAt: Math.max(revised.updatedAt + 1, services.now()),
          })
          await recordPlanEvent('plan.updated', updated, {
            summary: optionalStringArg(args, 'summary'),
          })
          if (updated.status === 'ready') await recordPlanEvent('plan.ready', updated)
          return JSON.stringify({ ok: true, planId: updated.id, status: updated.status })
        },
      },
      {
        spec: {
          type: 'function',
          function: {
            name: 'plan_request_input',
            description: 'Record a clarifying question on an existing plan.',
            parameters: {
              type: 'object',
              properties: {
                planId: { type: 'string' },
                questionId: { type: 'string' },
                prompt: { type: 'string' },
              },
              required: ['planId', 'prompt'],
              additionalProperties: false,
            },
          },
          metadata: planToolMetadata('plan_request_input'),
        },
        run: async (args) => {
          const getPlan = requirePlanMethod(services.store, 'getPlan')
          const updatePlan = requirePlanMethod(services.store, 'updatePlan')
          const planId = stringArg(args, 'planId')
          const current = await getPlan(conversationId, planId)
          const question: PlanQuestion = {
            id: optionalStringArg(args, 'questionId') ?? services.createId(),
            prompt: stringArg(args, 'prompt'),
            status: 'open',
          }
          const questions = [
            ...current.questions.filter((candidate) => candidate.id !== question.id),
            question,
          ]
          const updated = await updatePlan({
            ...current,
            status: 'needs_input',
            questions,
            updatedAt: Math.max(current.updatedAt + 1, services.now()),
          })
          await recordPlanEvent('plan.question.requested', updated, {
            questionId: question.id,
            prompt: question.prompt,
          })
          return JSON.stringify({ ok: true, planId: updated.id, questionId: question.id })
        },
      },
      {
        spec: {
          type: 'function',
          function: {
            name: 'plan_mark_ready',
            description: 'Mark an existing plan ready for user review and approval.',
            parameters: {
              type: 'object',
              properties: {
                planId: { type: 'string' },
                summary: { type: 'string' },
              },
              required: ['planId'],
              additionalProperties: false,
            },
          },
          metadata: planToolMetadata('plan_mark_ready'),
        },
        run: async (args) => {
          const getPlan = requirePlanMethod(services.store, 'getPlan')
          const updatePlan = requirePlanMethod(services.store, 'updatePlan')
          const planId = stringArg(args, 'planId')
          const current = await getPlan(conversationId, planId)
          const updated = await updatePlan({
            ...current,
            status: 'ready',
            updatedAt: Math.max(current.updatedAt + 1, services.now()),
          })
          await recordPlanEvent('plan.ready', updated, {
            summary: optionalStringArg(args, 'summary'),
          })
          return JSON.stringify({ ok: true, planId: updated.id, status: updated.status })
        },
      },
    ],
  }
}

export function createPlanImplementationToolPack(
  services: PlanToolServices,
  input: CreatePlanImplementationToolPackInput,
): ToolPack {
  const { conversationId, assistantMessageId, planId: activePlanId } = input
  const requireActivePlanId = (args: Record<string, unknown>): string => {
    const planId = stringArg(args, 'planId')
    if (planId !== activePlanId) {
      throw new Error(`plan tool cannot update inactive plan: ${planId}`)
    }
    return planId
  }
  const loadPlan = async (args: Record<string, unknown>): Promise<PlanArtifact> => {
    const planId = requireActivePlanId(args)
    return requirePlanMethod(services.store, 'getPlan')(conversationId, planId)
  }
  const savePlan = async (plan: PlanArtifact): Promise<PlanArtifact> =>
    requirePlanMethod(
      services.store,
      'updatePlan',
    )({
      ...plan,
      updatedAt: Math.max(plan.updatedAt + 1, services.now()),
    })
  const record = (type: RunEvent['type'], plan: PlanArtifact, data?: Record<string, unknown>) =>
    services.recordLifecycleEvent(type, { plan, messageId: assistantMessageId, data })

  return {
    id: 'aila-plan-implementation-tools',
    name: 'Aila Plan Implementation Tools',
    description: 'Update task progress and drift for the approved plan being implemented.',
    tools: [
      {
        spec: {
          type: 'function',
          function: {
            name: 'start_plan_task',
            description: 'Mark an approved plan task as in progress.',
            parameters: {
              type: 'object',
              properties: {
                planId: { type: 'string' },
                taskId: { type: 'string' },
                summary: { type: 'string' },
              },
              required: ['planId', 'taskId'],
              additionalProperties: false,
            },
          },
          metadata: planToolMetadata('start_plan_task'),
        },
        run: async (args) => {
          const taskId = stringArg(args, 'taskId')
          const current = await loadPlan(args)
          const updated = await savePlan(updatePlanTaskStatus(current, taskId, 'in_progress'))
          await record('plan.task.started', updated, {
            taskId,
            summary: optionalStringArg(args, 'summary'),
          })
          return JSON.stringify({ ok: true, planId: updated.id, taskId, status: 'in_progress' })
        },
      },
      {
        spec: {
          type: 'function',
          function: {
            name: 'complete_plan_task',
            description: 'Mark an approved plan task as completed.',
            parameters: {
              type: 'object',
              properties: {
                planId: { type: 'string' },
                taskId: { type: 'string' },
                summary: { type: 'string' },
              },
              required: ['planId', 'taskId'],
              additionalProperties: false,
            },
          },
          metadata: planToolMetadata('complete_plan_task'),
        },
        run: async (args) => {
          const taskId = stringArg(args, 'taskId')
          const current = await loadPlan(args)
          const updated = await savePlan(updatePlanTaskStatus(current, taskId, 'done'))
          await record('plan.task.completed', updated, {
            taskId,
            summary: optionalStringArg(args, 'summary'),
          })
          return JSON.stringify({ ok: true, planId: updated.id, taskId, status: 'done' })
        },
      },
      {
        spec: {
          type: 'function',
          function: {
            name: 'block_plan_task',
            description: 'Mark an approved plan task as blocked.',
            parameters: {
              type: 'object',
              properties: {
                planId: { type: 'string' },
                taskId: { type: 'string' },
                reason: { type: 'string' },
              },
              required: ['planId', 'taskId', 'reason'],
              additionalProperties: false,
            },
          },
          metadata: planToolMetadata('block_plan_task'),
        },
        run: async (args) => {
          const taskId = stringArg(args, 'taskId')
          const reason = stringArg(args, 'reason')
          const current = await loadPlan(args)
          const updated = await savePlan(updatePlanTaskStatus(current, taskId, 'blocked'))
          await record('plan.task.blocked', updated, { taskId, summary: reason })
          return JSON.stringify({ ok: true, planId: updated.id, taskId, status: 'blocked' })
        },
      },
      {
        spec: {
          type: 'function',
          function: {
            name: 'record_plan_drift',
            description: 'Record material drift discovered while implementing an approved plan.',
            parameters: {
              type: 'object',
              properties: {
                planId: { type: 'string' },
                driftId: { type: 'string' },
                severity: { type: 'string', enum: PLAN_DRIFT_SEVERITIES },
                summary: { type: 'string' },
                proposedChange: { type: 'string' },
              },
              required: ['planId', 'summary'],
              additionalProperties: false,
            },
          },
          metadata: planToolMetadata('record_plan_drift'),
        },
        run: async (args) => {
          const current = await loadPlan(args)
          const proposedChange = optionalStringArg(args, 'proposedChange')
          const drift = {
            id: optionalStringArg(args, 'driftId') ?? services.createId(),
            createdAt: services.now(),
            severity: planDriftSeverityArg(args, 'severity', 'warning'),
            summary: stringArg(args, 'summary'),
            ...(proposedChange ? { proposedChange } : {}),
          }
          const updated = await savePlan({ ...current, drift: [...current.drift, drift] })
          await record('plan.drift.detected', updated, {
            driftId: drift.id,
            severity: drift.severity,
            summary: drift.summary,
          })
          return JSON.stringify({ ok: true, planId: updated.id, driftId: drift.id })
        },
      },
      {
        spec: {
          type: 'function',
          function: {
            name: 'complete_plan',
            description: 'Mark the approved plan implementation as completed.',
            parameters: {
              type: 'object',
              properties: {
                planId: { type: 'string' },
                summary: { type: 'string' },
              },
              required: ['planId'],
              additionalProperties: false,
            },
          },
          metadata: planToolMetadata('complete_plan'),
        },
        run: async (args) => {
          const current = await loadPlan(args)
          const completedAt = services.now()
          const updated = await requirePlanMethod(
            services.store,
            'updatePlan',
          )({
            ...current,
            status: 'completed',
            completedAt,
            updatedAt: Math.max(current.updatedAt + 1, completedAt),
          })
          await record('plan.completed', updated, {
            summary: optionalStringArg(args, 'summary'),
          })
          return JSON.stringify({ ok: true, planId: updated.id, status: updated.status })
        },
      },
    ],
  }
}
