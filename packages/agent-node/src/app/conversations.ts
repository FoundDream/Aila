import type { UsageInfo } from '@aila/agent'
import { getPersistedRuntimeStore } from './runtime-store'

export interface TokenUsageDay {
  date: string
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cacheMissTokens: number
  reasoningTokens: number
  modelCallCount: number
  turnCount: number
}

export interface TokenUsageStats {
  generatedAt: number
  today: TokenUsageDay
  lifetime: TokenUsageDay
  peakDay: TokenUsageDay | null
  currentStreakDays: number
  longestStreakDays: number
  days: TokenUsageDay[]
}

export async function getTokenUsageStats(now = Date.now()): Promise<TokenUsageStats> {
  const store = getPersistedRuntimeStore()
  const days = new Map<string, TokenUsageDay>()
  for (const summary of (await store.listConversations?.()) ?? []) {
    for (const entry of await store.listSessionEntries(summary.id)) {
      if (entry.type !== 'usage.recorded') continue
      const date = new Date(entry.timestamp).toISOString().slice(0, 10)
      const day = days.get(date) ?? emptyUsageDay(date)
      addUsage(day, entry.data.usage)
      days.set(date, day)
    }
  }
  const ordered = [...days.values()].sort((left, right) => left.date.localeCompare(right.date))
  const lifetime = emptyUsageDay('lifetime')
  for (const day of ordered) addUsageDay(lifetime, day)
  const todayDate = new Date(now).toISOString().slice(0, 10)
  const today = structuredClone(days.get(todayDate) ?? emptyUsageDay(todayDate))
  const peakDay =
    ordered.reduce<TokenUsageDay | null>(
      (peak, day) => (!peak || day.totalTokens > peak.totalTokens ? day : peak),
      null,
    ) ?? null
  const streaks = usageStreaks(ordered)
  return {
    generatedAt: now,
    today,
    lifetime,
    peakDay: peakDay ? structuredClone(peakDay) : null,
    currentStreakDays: streaks.current,
    longestStreakDays: streaks.longest,
    days: structuredClone(ordered),
  }
}

function emptyUsageDay(date: string): TokenUsageDay {
  return {
    date,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheMissTokens: 0,
    reasoningTokens: 0,
    modelCallCount: 0,
    turnCount: 0,
  }
}

function addUsage(day: TokenUsageDay, usage: UsageInfo): void {
  day.totalTokens += usage.totalTokens
  day.inputTokens += usage.promptTokens
  day.outputTokens += usage.completionTokens
  day.cacheReadTokens += usage.cacheReadTokens ?? 0
  day.cacheWriteTokens += usage.cacheWriteTokens ?? 0
  day.cacheMissTokens += usage.cacheMissTokens ?? 0
  day.reasoningTokens += usage.reasoningTokens ?? 0
  day.modelCallCount += usage.modelCallCount ?? 1
  day.turnCount += 1
}

function addUsageDay(target: TokenUsageDay, source: TokenUsageDay): void {
  target.totalTokens += source.totalTokens
  target.inputTokens += source.inputTokens
  target.outputTokens += source.outputTokens
  target.cacheReadTokens += source.cacheReadTokens
  target.cacheWriteTokens += source.cacheWriteTokens
  target.cacheMissTokens += source.cacheMissTokens
  target.reasoningTokens += source.reasoningTokens
  target.modelCallCount += source.modelCallCount
  target.turnCount += source.turnCount
}

function usageStreaks(days: readonly TokenUsageDay[]): { current: number; longest: number } {
  let current = 0
  let longest = 0
  let previous: number | null = null
  for (const day of days) {
    const value = Date.parse(`${day.date}T00:00:00Z`)
    current = previous !== null && value - previous === 86_400_000 ? current + 1 : 1
    longest = Math.max(longest, current)
    previous = value
  }
  return { current, longest }
}
