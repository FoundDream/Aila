export interface MarkdownHeading {
  id: string
  level: number
  text: string
  line: number
}

interface ExtractHeadingOptions {
  minLevel?: number
  maxLevel?: number
}

type HastNode = {
  type?: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

const ATX_HEADING_RE = /^( {0,3})(#{1,6})(?:[ \t]+|$)(.*)$/
const FENCE_RE = /^( {0,3})(`{3,}|~{3,})/
const HTML_HEADING_RE = /<h([1-6])(?:\s[^>]*)?>([\s\S]*?)<\/h\1>/gi

type HeadingCandidate = MarkdownHeading & {
  offset: number
}

type SourceRange = {
  end: number
  start: number
}

function stripInlineMarkdown(value: string): string {
  return value
    .replace(/\\([\\`*_[\]{}()#+\-.!|>])/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(
      /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
      (_match, target: string, alias?: string) => alias ?? target,
    )
    .replace(/[*_~]+/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function stripHtml(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim()
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[`*_[\]{}()#+.!|>~]/g, '')
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return slug || 'heading'
}

function uniqueId(base: string, seen: Map<string, number>): string {
  const count = seen.get(base) ?? 0
  seen.set(base, count + 1)
  return count === 0 ? base : `${base}-${count + 1}`
}

function collectText(node: HastNode): string {
  if (node.type === 'text') return node.value ?? ''
  if (!node.children) return ''
  return node.children.map(collectText).join('')
}

function visitHeadings(node: HastNode, seen: Map<string, number>): void {
  if (node.type === 'element' && /^h[1-6]$/.test(node.tagName ?? '')) {
    const text = collectText(node).replace(/\s+/g, ' ').trim()
    if (text.length > 0) {
      node.properties = {
        ...node.properties,
        id: uniqueId(slugify(text), seen),
      }
    }
  }

  for (const child of node.children ?? []) {
    visitHeadings(child, seen)
  }
}

export function extractMarkdownHeadings(
  content: string,
  { minLevel = 1, maxLevel = 6 }: ExtractHeadingOptions = {},
): MarkdownHeading[] {
  const candidates: HeadingCandidate[] = []
  const seen = new Map<string, number>()
  const lines = content.split(/\r?\n/)
  const fencedRanges: SourceRange[] = []
  let fenceChar: '`' | '~' | null = null
  let fenceLength = 0
  let fenceStart = 0
  let offset = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const nextOffset = offset + line.length + lineBreakLength(content, offset + line.length)
    const fenceMatch = line.match(FENCE_RE)
    if (fenceMatch) {
      const marker = fenceMatch[2]
      const markerChar = marker[0] as '`' | '~'
      if (fenceChar === null) {
        fenceChar = markerChar
        fenceLength = marker.length
        fenceStart = offset
        offset = nextOffset
        continue
      }
      if (markerChar === fenceChar && marker.length >= fenceLength) {
        fencedRanges.push({ start: fenceStart, end: offset + line.length })
        fenceChar = null
        fenceLength = 0
      }
      offset = nextOffset
      continue
    }

    if (fenceChar !== null) {
      offset = nextOffset
      continue
    }

    const match = line.match(ATX_HEADING_RE)
    if (!match) {
      offset = nextOffset
      continue
    }

    const level = match[2].length
    if (level < minLevel || level > maxLevel) {
      offset = nextOffset
      continue
    }

    const rawText = match[3].replace(/[ \t]+#+[ \t]*$/, '').trim()
    const text = stripInlineMarkdown(rawText)
    if (text.length === 0) {
      offset = nextOffset
      continue
    }

    candidates.push({
      id: '',
      level,
      line: i + 1,
      offset,
      text,
    })
    offset = nextOffset
  }

  if (fenceChar !== null) {
    fencedRanges.push({ start: fenceStart, end: content.length })
  }

  HTML_HEADING_RE.lastIndex = 0
  for (const match of content.matchAll(HTML_HEADING_RE)) {
    const headingOffset = match.index
    if (isInsideRange(headingOffset, fencedRanges)) continue

    const level = Number(match[1])
    if (level < minLevel || level > maxLevel) continue

    const text = stripHtml(match[2])
    if (text.length === 0) continue

    candidates.push({
      id: '',
      level,
      line: lineNumberAtOffset(content, headingOffset),
      offset: headingOffset,
      text,
    })
  }

  return candidates
    .sort((a, b) => a.offset - b.offset)
    .map(({ offset: _offset, ...heading }) => ({
      ...heading,
      id: uniqueId(slugify(heading.text), seen),
    }))
}

function isInsideRange(offset: number, ranges: SourceRange[]): boolean {
  return ranges.some((range) => offset >= range.start && offset <= range.end)
}

function lineNumberAtOffset(content: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset; i += 1) {
    if (content.charCodeAt(i) === 10) line += 1
  }
  return line
}

function lineBreakLength(content: string, index: number): number {
  if (content[index] === '\r' && content[index + 1] === '\n') return 2
  return content[index] === '\n' || content[index] === '\r' ? 1 : 0
}

export function createHeadingIdRehypePlugin(): (tree: HastNode) => void {
  return (tree: HastNode): void => {
    visitHeadings(tree, new Map())
  }
}
