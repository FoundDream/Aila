export const AILA_PLAN_ARTIFACT_SCHEMA_VERSION = 1
export const AILA_PLAN_REVISION_SCHEMA_VERSION = 1

export const PLAN_STATUSES = [
  'draft',
  'needs_input',
  'ready',
  'approved',
  'implementing',
  'completed',
  'cancelled',
  'superseded',
] as const
export type PlanStatus = (typeof PLAN_STATUSES)[number]

export const PLAN_TASK_STATUSES = ['todo', 'in_progress', 'done', 'blocked', 'skipped'] as const
export type PlanTaskStatus = (typeof PLAN_TASK_STATUSES)[number]

export const PLAN_FILE_REFERENCE_KINDS = ['read', 'modify', 'create', 'delete', 'verify'] as const
export type PlanFileReferenceKind = (typeof PLAN_FILE_REFERENCE_KINDS)[number]

export const PLAN_QUESTION_STATUSES = ['open', 'answered', 'dismissed'] as const
export type PlanQuestionStatus = (typeof PLAN_QUESTION_STATUSES)[number]

export const PLAN_DRIFT_SEVERITIES = ['info', 'warning', 'requires_approval'] as const
export type PlanDriftSeverity = (typeof PLAN_DRIFT_SEVERITIES)[number]

export const PLAN_REVISION_AUTHORS = ['assistant', 'user', 'system'] as const
export type PlanRevisionAuthor = (typeof PLAN_REVISION_AUTHORS)[number]

export const PLAN_APPROVED_BY_VALUES = ['user', 'automation'] as const
export type PlanApprovedBy = 'user' | 'automation'

export interface PlanFileReference {
  path: string
  reason: string
  kind?: PlanFileReferenceKind
}

export interface PlanTask {
  id: string
  title: string
  status: PlanTaskStatus
  detail?: string
  files?: PlanFileReference[]
  verification?: string[]
  dependsOn?: string[]
}

export interface PlanQuestion {
  id: string
  prompt: string
  status: PlanQuestionStatus
  answer?: string
}

export interface PlanDriftRecord {
  id: string
  createdAt: number
  severity: PlanDriftSeverity
  summary: string
  proposedChange?: string
  resolvedAt?: number
}

export interface PlanRevision {
  schemaVersion: typeof AILA_PLAN_REVISION_SCHEMA_VERSION
  id: string
  planId: string
  createdAt: number
  author: PlanRevisionAuthor
  markdown: string
  tasks: PlanTask[]
  summary?: string
}

export interface PlanArtifact {
  schemaVersion: typeof AILA_PLAN_ARTIFACT_SCHEMA_VERSION
  id: string
  conversationId: string
  sourceUserMessageId: string
  latestAssistantMessageId?: string
  title: string
  status: PlanStatus
  markdown: string
  tasks: PlanTask[]
  questions: PlanQuestion[]
  assumptions: string[]
  risks: string[]
  files: PlanFileReference[]
  verification: string[]
  drift: PlanDriftRecord[]
  revisions: PlanRevision[]
  createdAt: number
  updatedAt: number
  latestRevisionId?: string
  approvedRevisionId?: string
  approvedAt?: number
  approvedBy?: PlanApprovedBy
  completedAt?: number
  supersedesPlanId?: string
}

export interface PlanRevisionInput {
  conversationId: string
  planId: string
  revision: PlanRevision
}

type UnknownRecord = Record<string, unknown>

const PLAN_STATUS_SET = new Set<string>(PLAN_STATUSES)
const PLAN_TASK_STATUS_SET = new Set<string>(PLAN_TASK_STATUSES)
const PLAN_FILE_REFERENCE_KIND_SET = new Set<string>(PLAN_FILE_REFERENCE_KINDS)
const PLAN_QUESTION_STATUS_SET = new Set<string>(PLAN_QUESTION_STATUSES)
const PLAN_DRIFT_SEVERITY_SET = new Set<string>(PLAN_DRIFT_SEVERITIES)
const PLAN_REVISION_AUTHOR_SET = new Set<string>(PLAN_REVISION_AUTHORS)
const PLAN_APPROVED_BY_SET = new Set<string>(PLAN_APPROVED_BY_VALUES)

function clonePlanValue<T>(value: T): T {
  return structuredClone(value)
}

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null
}

function stringValue(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function optionalString(value: unknown): string | undefined {
  return stringValue(value) ?? undefined
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function optionalNumber(value: unknown): number | undefined {
  return numberValue(value) ?? undefined
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map(stringValue).filter((entry): entry is string => entry !== null)
}

function normalizeEnum<T extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
  fallback: T,
): T {
  return typeof value === 'string' && allowed.has(value) ? (value as T) : fallback
}

function normalizeOptionalEnum<T extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
): T | undefined {
  return typeof value === 'string' && allowed.has(value) ? (value as T) : undefined
}

function normalizePlanFileReference(value: unknown): PlanFileReference | null {
  const record = asRecord(value)
  if (!record) return null
  const path = stringValue(record.path)
  const reason = stringValue(record.reason)
  if (!path || !reason) return null
  const kind = normalizeOptionalEnum<PlanFileReferenceKind>(
    record.kind,
    PLAN_FILE_REFERENCE_KIND_SET,
  )
  return {
    path,
    reason,
    ...(kind ? { kind } : {}),
  }
}

function normalizePlanFileReferences(value: unknown): PlanFileReference[] {
  if (!Array.isArray(value)) return []
  return value
    .map(normalizePlanFileReference)
    .filter((reference): reference is PlanFileReference => reference !== null)
}

function normalizePlanTask(value: unknown): PlanTask | null {
  const record = asRecord(value)
  if (!record) return null
  const id = stringValue(record.id)
  const title = stringValue(record.title)
  if (!id || !title) return null
  const detail = optionalString(record.detail)
  return {
    id,
    title,
    status: normalizeEnum<PlanTaskStatus>(record.status, PLAN_TASK_STATUS_SET, 'todo'),
    ...(detail ? { detail } : {}),
    files: normalizePlanFileReferences(record.files),
    verification: normalizeStringArray(record.verification),
    dependsOn: normalizeStringArray(record.dependsOn),
  }
}

function normalizePlanTasks(value: unknown): PlanTask[] {
  if (!Array.isArray(value)) return []
  return value.map(normalizePlanTask).filter((task): task is PlanTask => task !== null)
}

function normalizePlanQuestion(value: unknown): PlanQuestion | null {
  const record = asRecord(value)
  if (!record) return null
  const id = stringValue(record.id)
  const prompt = stringValue(record.prompt)
  if (!id || !prompt) return null
  const answer = optionalString(record.answer)
  return {
    id,
    prompt,
    status: normalizeEnum<PlanQuestionStatus>(record.status, PLAN_QUESTION_STATUS_SET, 'open'),
    ...(answer ? { answer } : {}),
  }
}

function normalizePlanQuestions(value: unknown): PlanQuestion[] {
  if (!Array.isArray(value)) return []
  return value
    .map(normalizePlanQuestion)
    .filter((question): question is PlanQuestion => question !== null)
}

function normalizePlanDriftRecord(value: unknown): PlanDriftRecord | null {
  const record = asRecord(value)
  if (!record) return null
  const id = stringValue(record.id)
  const summary = stringValue(record.summary)
  const createdAt = numberValue(record.createdAt)
  if (!id || !summary || createdAt === null) return null
  const proposedChange = optionalString(record.proposedChange)
  const resolvedAt = optionalNumber(record.resolvedAt)
  return {
    id,
    createdAt,
    severity: normalizeEnum<PlanDriftSeverity>(record.severity, PLAN_DRIFT_SEVERITY_SET, 'info'),
    summary,
    ...(proposedChange ? { proposedChange } : {}),
    ...(resolvedAt !== undefined ? { resolvedAt } : {}),
  }
}

function normalizePlanDrift(value: unknown): PlanDriftRecord[] {
  if (!Array.isArray(value)) return []
  return value
    .map(normalizePlanDriftRecord)
    .filter((drift): drift is PlanDriftRecord => drift !== null)
}

export function normalizePlanRevision(
  value: unknown,
  fallbackPlanId?: string,
): PlanRevision | null {
  const record = asRecord(value)
  if (!record) return null
  const id = stringValue(record.id)
  const planId = stringValue(record.planId) ?? stringValue(fallbackPlanId)
  const markdown = stringValue(record.markdown)
  const createdAt = numberValue(record.createdAt)
  if (!id || !planId || !markdown || createdAt === null) return null
  const summary = optionalString(record.summary)
  return {
    schemaVersion: AILA_PLAN_REVISION_SCHEMA_VERSION,
    id,
    planId,
    createdAt,
    author: normalizeEnum<PlanRevisionAuthor>(record.author, PLAN_REVISION_AUTHOR_SET, 'assistant'),
    markdown,
    tasks: normalizePlanTasks(record.tasks),
    ...(summary ? { summary } : {}),
  }
}

export function preparePlanRevision(revision: PlanRevision, planId?: string): PlanRevision {
  const normalized = normalizePlanRevision(revision, planId)
  if (!normalized) throw new Error('invalid plan revision')
  return normalized
}

export function orderedUniquePlanRevisions(value: readonly PlanRevision[]): PlanRevision[] {
  const byId = new Map<string, PlanRevision>()
  for (const revision of value) {
    const normalized = normalizePlanRevision(revision)
    if (normalized) byId.set(normalized.id, normalized)
  }
  return [...byId.values()].sort((left, right) => {
    const createdAtDiff = left.createdAt - right.createdAt
    return createdAtDiff === 0 ? left.id.localeCompare(right.id) : createdAtDiff
  })
}

function normalizePlanRevisions(value: unknown, planId: string): PlanRevision[] {
  if (!Array.isArray(value)) return []
  return orderedUniquePlanRevisions(
    value
      .map((revision) => normalizePlanRevision(revision, planId))
      .filter((revision): revision is PlanRevision => revision !== null),
  )
}

export function normalizePlanArtifact(
  value: unknown,
  fallbackConversationId?: string,
): PlanArtifact | null {
  const record = asRecord(value)
  if (!record) return null
  const id = stringValue(record.id)
  const conversationId = stringValue(record.conversationId) ?? stringValue(fallbackConversationId)
  const sourceUserMessageId = stringValue(record.sourceUserMessageId)
  const title = stringValue(record.title)
  const markdown = stringValue(record.markdown)
  if (!id || !conversationId || !sourceUserMessageId || !title || !markdown) return null

  const latestAssistantMessageId = optionalString(record.latestAssistantMessageId)
  const latestRevisionId = optionalString(record.latestRevisionId)
  const approvedRevisionId = optionalString(record.approvedRevisionId)
  const approvedAt = optionalNumber(record.approvedAt)
  const approvedBy = normalizeOptionalEnum<PlanApprovedBy>(record.approvedBy, PLAN_APPROVED_BY_SET)
  const completedAt = optionalNumber(record.completedAt)
  const supersedesPlanId = optionalString(record.supersedesPlanId)
  const createdAt = numberValue(record.createdAt) ?? 0
  const updatedAt = Math.max(numberValue(record.updatedAt) ?? createdAt, createdAt)

  return {
    schemaVersion: AILA_PLAN_ARTIFACT_SCHEMA_VERSION,
    id,
    conversationId,
    sourceUserMessageId,
    ...(latestAssistantMessageId ? { latestAssistantMessageId } : {}),
    title,
    status: normalizeEnum<PlanStatus>(record.status, PLAN_STATUS_SET, 'draft'),
    markdown,
    tasks: normalizePlanTasks(record.tasks),
    questions: normalizePlanQuestions(record.questions),
    assumptions: normalizeStringArray(record.assumptions),
    risks: normalizeStringArray(record.risks),
    files: normalizePlanFileReferences(record.files),
    verification: normalizeStringArray(record.verification),
    drift: normalizePlanDrift(record.drift),
    revisions: normalizePlanRevisions(record.revisions, id),
    createdAt,
    updatedAt,
    ...(latestRevisionId ? { latestRevisionId } : {}),
    ...(approvedRevisionId ? { approvedRevisionId } : {}),
    ...(approvedAt !== undefined ? { approvedAt } : {}),
    ...(approvedBy ? { approvedBy } : {}),
    ...(completedAt !== undefined ? { completedAt } : {}),
    ...(supersedesPlanId ? { supersedesPlanId } : {}),
  }
}

export function preparePlanArtifact(plan: PlanArtifact): PlanArtifact {
  const normalized = normalizePlanArtifact(plan)
  if (!normalized) throw new Error('invalid plan artifact')
  return normalized
}

export function appendPlanRevisionToPlan(
  plan: PlanArtifact,
  revision: PlanRevision,
  updatedAt?: number,
): PlanArtifact {
  const preparedPlan = preparePlanArtifact(plan)
  const preparedRevision = preparePlanRevision(revision, preparedPlan.id)
  const revisions = orderedUniquePlanRevisions([...preparedPlan.revisions, preparedRevision])
  return {
    ...clonePlanValue(preparedPlan),
    markdown: preparedRevision.markdown,
    tasks: clonePlanValue(preparedRevision.tasks),
    revisions,
    latestRevisionId: preparedRevision.id,
    updatedAt: Math.max(
      preparedPlan.updatedAt + 1,
      preparedRevision.createdAt,
      updatedAt ?? preparedRevision.createdAt,
    ),
  }
}
