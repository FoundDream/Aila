type Segment = {
  readonly text: string
  readonly isProtected: boolean
}

type EnclosurePair = readonly [open: string, close: string]
type NormalizationRule = (segment: string) => string

const PROTECTED_MARKDOWN_PATTERN =
  /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`|<!--[\s\S]*?-->|<([A-Za-z][\w:-]*)\b[^>\n]*>[\s\S]*?<\/\2>|<\/?[A-Za-z][^>\n]*>)/g

const EMPHASIS_MARKERS = ['***', '___', '**', '__', '*', '_'] as const

const ENCLOSURE_PAIRS: readonly EnclosurePair[] = [
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
  ['‘', '’'],
  ['「', '」'],
  ['『', '』'],
  ['《', '》'],
  ['〈', '〉'],
  ['«', '»'],
  ['‹', '›'],
  ['（', '）'],
  ['(', ')'],
  ['【', '】'],
  ['[', ']'],
  ['〔', '〕'],
] as const

const normalizationRules: readonly NormalizationRule[] = [normalizeEnclosedEmphasis]

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function hasTrimmedEdges(value: string): boolean {
  return value.length > 0 && value === value.trim()
}

function splitProtectedMarkdownSegments(content: string): Segment[] {
  const segments: Segment[] = []
  let lastIndex = 0

  for (const match of content.matchAll(PROTECTED_MARKDOWN_PATTERN)) {
    const index = match.index ?? 0
    const protectedText = match[0]

    if (index > lastIndex) {
      segments.push({
        text: content.slice(lastIndex, index),
        isProtected: false,
      })
    }

    segments.push({
      text: protectedText,
      isProtected: true,
    })

    lastIndex = index + protectedText.length
  }

  if (lastIndex < content.length) {
    segments.push({
      text: content.slice(lastIndex),
      isProtected: false,
    })
  }

  return segments
}

function normalizeEnclosedEmphasis(segment: string): string {
  let normalized = segment

  for (const marker of EMPHASIS_MARKERS) {
    const escapedMarker = escapeRegExp(marker)

    for (const [open, close] of ENCLOSURE_PAIRS) {
      const pattern = new RegExp(
        `${escapedMarker}${escapeRegExp(open)}([^\\n]+?)${escapeRegExp(close)}${escapedMarker}`,
        'g',
      )

      normalized = normalized.replace(pattern, (match, inner: string) => {
        if (!hasTrimmedEdges(inner)) {
          return match
        }

        return `${open}${marker}${inner}${marker}${close}`
      })
    }
  }

  return normalized
}

function normalizeTextSegment(segment: string): string {
  return normalizationRules.reduce((value, rule) => rule(value), segment)
}

export function normalizeMarkdown(content: string): string {
  return splitProtectedMarkdownSegments(content)
    .map((segment) => {
      if (segment.isProtected) {
        return segment.text
      }

      return normalizeTextSegment(segment.text)
    })
    .join('')
}
