import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { app } from 'electron'
import type {
  AssistantContentPart,
  CompleteResult,
  LLMAuth,
  LLMClient,
  ModelInfo,
} from '../agent-core/types'

type MemorySourceType = 'explicit' | 'inferred'
type MemoryStatus = 'active' | 'deleted'

interface MemoryItemRow {
  id: string
  kind: 'preference'
  scope: 'user'
  key: string
  value_json: string
  source_type: MemorySourceType
  confidence: number
  status: MemoryStatus
  reason: string | null
  evidence_count: number
  created_at: string
  updated_at: string
  last_confirmed_at: string | null
  last_applied_at: string | null
}

export interface PreferenceMemory {
  id: string
  key: string
  value: string
  sourceType: MemorySourceType
  confidence: number
  reason: string | null
  evidenceCount: number
  updatedAt: string
}

export interface PreferenceMemoryUpdateInput {
  id: string
  reason?: string | null
  value: string
}

interface ExtractionCandidate {
  key: string
  value: string
  sourceType: MemorySourceType
  confidence: number
  reason: string
}

interface ExtractorResult {
  candidates: ExtractionCandidate[]
}

interface ReconcilerOperation {
  action: 'ADD' | 'UPDATE' | 'DELETE' | 'NONE'
  key?: string
  value?: string
  memoryId?: string
  sourceType?: MemorySourceType
  confidence?: number
  reason: string
}

interface ReconcilerResult {
  operations: ReconcilerOperation[]
}

interface CurateTurnOptions {
  assistantText: string
  userText: string
  modelInfo: ModelInfo
  auth: LLMAuth
  llmClient: LLMClient
}

const EXTRACTOR_PROMPT = `You extract long-lived user preference memories from a single assistant turn.

Only extract preferences that are likely to be useful in future conversations with the same user.
Focus on durable user preferences about how the assistant should respond or collaborate.

Allowed keys:
- response_language
- response_tone
- response_length
- explanation_style
- formatting_preference
- tool_preference
- coding_preference

Rules:
- Return JSON only.
- Ignore one-off task requirements.
- Ignore project-specific instructions and repository rules.
- Ignore facts about the current task unless the user states them as a future preference.
- Prefer exact normalized values like "zh-CN", "concise", "step-by-step", "markdown", "bun".
- sourceType must be "explicit" when the user directly states a preference or correction.
- sourceType must be "inferred" only when the signal is weaker but still likely reusable.
- If nothing should be remembered, return {"candidates":[]}.

JSON shape:
{
  "candidates": [
    {
      "key": "response_language",
      "value": "zh-CN",
      "sourceType": "explicit",
      "confidence": 0.98,
      "reason": "User explicitly asked for future replies in Chinese."
    }
  ]
}`

const RECONCILER_PROMPT = `You reconcile new preference-memory candidates against an existing memory store.

You must decide one of:
- ADD: candidate is new and should be stored
- UPDATE: candidate replaces or improves an existing memory entry
- DELETE: user explicitly reversed or removed an existing memory entry
- NONE: candidate should not change memory

Rules:
- Return JSON only.
- Only operate on preference memory.
- Prefer explicit user statements over inferred preferences.
- If a candidate repeats the same meaning as an existing memory, use NONE.
- If a candidate conflicts with an existing memory for the same key, use UPDATE with the existing memoryId.
- Use DELETE only when the new information explicitly negates a stored preference.
- If no change is needed, return {"operations":[]}.

JSON shape:
{
  "operations": [
    {
      "action": "UPDATE",
      "memoryId": "existing-id",
      "key": "response_language",
      "value": "zh-CN",
      "sourceType": "explicit",
      "confidence": 0.99,
      "reason": "The user explicitly corrected the preferred language."
    }
  ]
}`

function safeJsonParse<T>(raw: string): T | null {
  const trimmed = raw.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const payload = fenced?.[1]?.trim() ?? trimmed

  try {
    return JSON.parse(payload) as T
  } catch {
    return null
  }
}

function extractTextFromResponse(response: CompleteResult): string {
  return response.content
    .filter(
      (block): block is Extract<AssistantContentPart, { type: 'text' }> => block.type === 'text',
    )
    .map((block) => block.text)
    .join('\n')
}

function normalizeValue(value: string): string {
  return value.trim()
}

function clampConfidence(value: number | undefined): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0.5
  return Math.max(0, Math.min(1, value))
}

export class PreferenceMemoryService {
  private db: DatabaseSync

  constructor(dbPath?: string) {
    const baseDir = join(app.getPath('userData'), 'memory')
    mkdirSync(baseDir, { recursive: true })
    const resolvedPath = dbPath ?? join(baseDir, 'preferences.sqlite')

    if (!existsSync(baseDir)) {
      mkdirSync(baseDir, { recursive: true })
    }

    this.db = new DatabaseSync(resolvedPath)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS memory_items (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        source_type TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active',
        reason TEXT,
        evidence_count INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_confirmed_at TEXT,
        last_applied_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_memory_items_active ON memory_items(kind, scope, status, key);
      CREATE TABLE IF NOT EXISTS memory_events (
        id TEXT PRIMARY KEY,
        memory_item_id TEXT,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_events_item ON memory_events(memory_item_id, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_items_unique_active_preference
      ON memory_items(kind, scope, key)
      WHERE status = 'active';
    `)
  }

  destroy(): void {
    this.db.close()
  }

  listActivePreferences(limit = 8): PreferenceMemory[] {
    const rows = this.db
      .prepare(
        `
          SELECT *
          FROM memory_items
          WHERE kind = 'preference'
            AND scope = 'user'
            AND status = 'active'
          ORDER BY
            CASE source_type WHEN 'explicit' THEN 0 ELSE 1 END,
            confidence DESC,
            updated_at DESC
          LIMIT ?
        `,
      )
      .all(limit) as unknown as MemoryItemRow[]

    return rows.map((row) => ({
      id: row.id,
      key: row.key,
      value: JSON.parse(row.value_json) as string,
      sourceType: row.source_type,
      confidence: row.confidence,
      reason: row.reason,
      evidenceCount: row.evidence_count,
      updatedAt: row.updated_at,
    }))
  }

  listManageablePreferences(): PreferenceMemory[] {
    return this.listActivePreferences(100)
  }

  getPromptContext(limit = 8): { ids: string[]; text: string } {
    const memories = this.listActivePreferences(limit)
    if (memories.length === 0) {
      return { ids: [], text: '' }
    }

    const lines = memories.map((memory) => `- ${memory.key}: ${memory.value}`)

    return {
      ids: memories.map((memory) => memory.id),
      text: `## User Preference Memory\n${lines.join('\n')}`,
    }
  }

  markApplied(memoryIds: string[]): void {
    if (memoryIds.length === 0) return

    const now = new Date().toISOString()
    const stmt = this.db.prepare(`
      UPDATE memory_items
      SET last_applied_at = ?
      WHERE id = ?
    `)

    for (const memoryId of memoryIds) {
      stmt.run(now, memoryId)
      this.insertEvent(memoryId, 'applied', { at: now })
    }
  }

  updatePreference({ id, reason, value }: PreferenceMemoryUpdateInput): void {
    const current = this.db
      .prepare(
        `
          SELECT id, value_json, reason, evidence_count
          FROM memory_items
          WHERE id = ?
            AND kind = 'preference'
            AND scope = 'user'
            AND status = 'active'
        `,
      )
      .get(id) as unknown as
      | { id: string; value_json: string; reason: string | null; evidence_count: number }
      | undefined

    if (!current) {
      throw new Error('Memory item not found')
    }

    const normalizedValue = normalizeValue(value)
    if (!normalizedValue) {
      throw new Error('Memory value cannot be empty')
    }

    const now = new Date().toISOString()
    this.db
      .prepare(
        `
          UPDATE memory_items
          SET value_json = ?,
              reason = ?,
              updated_at = ?
          WHERE id = ?
        `,
      )
      .run(JSON.stringify(normalizedValue), reason?.trim() || null, now, id)

    this.insertEvent(id, 'edited', {
      nextReason: reason?.trim() || null,
      nextValue: normalizedValue,
      previousReason: current.reason,
      previousValue: JSON.parse(current.value_json) as string,
    })
  }

  deletePreference(id: string): void {
    const current = this.db
      .prepare(
        `
          SELECT id
          FROM memory_items
          WHERE id = ?
            AND kind = 'preference'
            AND scope = 'user'
            AND status = 'active'
        `,
      )
      .get(id) as unknown as { id: string } | undefined

    if (!current) {
      throw new Error('Memory item not found')
    }

    const now = new Date().toISOString()
    this.db
      .prepare(
        `
          UPDATE memory_items
          SET status = 'deleted',
              updated_at = ?
          WHERE id = ?
        `,
      )
      .run(now, id)

    this.insertEvent(id, 'deleted', { origin: 'manual' })
  }

  async curateTurn({
    assistantText,
    userText,
    modelInfo,
    auth,
    llmClient,
  }: CurateTurnOptions): Promise<void> {
    const trimmedUserText = userText.trim()
    if (!trimmedUserText) return

    const extractorInput = {
      userMessage: trimmedUserText,
      assistantMessage: assistantText.trim(),
    }

    const extractionResponse = await llmClient.complete(
      {
        model: modelInfo,
        systemPrompt: EXTRACTOR_PROMPT,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: JSON.stringify(extractorInput, null, 2) }],
          },
        ],
      },
      auth,
    )

    const extractorResult = safeJsonParse<ExtractorResult>(
      extractTextFromResponse(extractionResponse),
    )
    const candidates = extractorResult?.candidates
      ?.map((candidate) => ({
        ...candidate,
        value: normalizeValue(candidate.value),
        confidence: clampConfidence(candidate.confidence),
      }))
      .filter(
        (candidate) =>
          candidate.key &&
          candidate.value &&
          [
            'response_language',
            'response_tone',
            'response_length',
            'explanation_style',
            'formatting_preference',
            'tool_preference',
            'coding_preference',
          ].includes(candidate.key),
      )

    if (!candidates || candidates.length === 0) return

    const existing = this.listActivePreferences(100)
    const reconcileInput = {
      candidates,
      existingMemories: existing,
    }

    const reconcileResponse = await llmClient.complete(
      {
        model: modelInfo,
        systemPrompt: RECONCILER_PROMPT,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: JSON.stringify(reconcileInput, null, 2) }],
          },
        ],
      },
      auth,
    )

    const reconcileResult = safeJsonParse<ReconcilerResult>(
      extractTextFromResponse(reconcileResponse),
    )
    const operations = reconcileResult?.operations ?? []
    if (operations.length === 0) return

    this.applyOperations(operations)
  }

  private applyOperations(operations: ReconcilerOperation[]): void {
    const now = new Date().toISOString()

    this.db.exec('BEGIN')

    try {
      for (const operation of operations) {
        switch (operation.action) {
          case 'ADD': {
            if (!operation.key || !operation.value || !operation.sourceType) continue
            const existing = this.getActiveRowByKey(operation.key)
            if (existing) {
              this.db
                .prepare(
                  `
                    UPDATE memory_items
                    SET value_json = ?,
                        source_type = ?,
                        confidence = ?,
                        reason = ?,
                        evidence_count = ?,
                        updated_at = ?,
                        last_confirmed_at = CASE WHEN ? = 'explicit' THEN ? ELSE last_confirmed_at END
                    WHERE id = ?
                  `,
                )
                .run(
                  JSON.stringify(operation.value),
                  operation.sourceType,
                  clampConfidence(operation.confidence),
                  operation.reason,
                  existing.evidence_count + 1,
                  now,
                  operation.sourceType,
                  now,
                  existing.id,
                )
              this.insertEvent(existing.id, 'updated', {
                ...operation,
                previousValue: JSON.parse(existing.value_json) as string,
                upgradedFrom: 'ADD',
              })
              break
            }
            const id = randomUUID()
            this.db
              .prepare(
                `
                  INSERT INTO memory_items (
                    id, kind, scope, key, value_json, source_type, confidence, status, reason,
                    evidence_count, created_at, updated_at, last_confirmed_at, last_applied_at
                  ) VALUES (?, 'preference', 'user', ?, ?, ?, ?, 'active', ?, 1, ?, ?, ?, NULL)
                `,
              )
              .run(
                id,
                operation.key,
                JSON.stringify(operation.value),
                operation.sourceType,
                clampConfidence(operation.confidence),
                operation.reason,
                now,
                now,
                operation.sourceType === 'explicit' ? now : null,
              )
            this.insertEvent(id, 'created', operation)
            break
          }
          case 'UPDATE': {
            if (!operation.memoryId || !operation.key || !operation.value || !operation.sourceType)
              continue
            const current =
              (this.db
                .prepare(
                  `SELECT id, value_json, evidence_count FROM memory_items WHERE id = ? AND status = 'active'`,
                )
                .get(operation.memoryId) as unknown as
                | { id: string; value_json: string; evidence_count: number }
                | undefined) ?? this.getActiveRowByKey(operation.key)
            if (!current) continue

            this.db
              .prepare(
                `
                  UPDATE memory_items
                  SET key = ?,
                      value_json = ?,
                      source_type = ?,
                      confidence = ?,
                      reason = ?,
                      evidence_count = ?,
                      updated_at = ?,
                      last_confirmed_at = CASE WHEN ? = 'explicit' THEN ? ELSE last_confirmed_at END
                  WHERE id = ?
                `,
              )
              .run(
                operation.key,
                JSON.stringify(operation.value),
                operation.sourceType,
                clampConfidence(operation.confidence),
                operation.reason,
                current.evidence_count + 1,
                now,
                operation.sourceType,
                now,
                current.id,
              )
            this.insertEvent(current.id, 'updated', {
              ...operation,
              previousValue: JSON.parse(current.value_json) as string,
            })
            break
          }
          case 'DELETE': {
            if (!operation.memoryId) continue
            this.db
              .prepare(
                `
                  UPDATE memory_items
                  SET status = 'deleted',
                      updated_at = ?
                  WHERE id = ?
                `,
              )
              .run(now, operation.memoryId)
            this.insertEvent(operation.memoryId, 'deleted', operation)
            break
          }
          case 'NONE':
            break
        }
      }

      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private insertEvent(memoryItemId: string | null, eventType: string, payload: unknown): void {
    this.db
      .prepare(
        `
          INSERT INTO memory_events (id, memory_item_id, event_type, payload_json, created_at)
          VALUES (?, ?, ?, ?, ?)
        `,
      )
      .run(randomUUID(), memoryItemId, eventType, JSON.stringify(payload), new Date().toISOString())
  }

  private getActiveRowByKey(
    key: string,
  ): { id: string; value_json: string; evidence_count: number } | undefined {
    return this.db
      .prepare(
        `
          SELECT id, value_json, evidence_count
          FROM memory_items
          WHERE kind = 'preference'
            AND scope = 'user'
            AND key = ?
            AND status = 'active'
        `,
      )
      .get(key) as unknown as { id: string; value_json: string; evidence_count: number } | undefined
  }
}
