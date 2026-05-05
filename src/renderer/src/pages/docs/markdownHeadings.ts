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
  const headings: MarkdownHeading[] = []
  const seen = new Map<string, number>()
  const lines = content.split(/\r?\n/)
  let fenceChar: '`' | '~' | null = null
  let fenceLength = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fenceMatch = line.match(FENCE_RE)
    if (fenceMatch) {
      const marker = fenceMatch[2]
      const markerChar = marker[0] as '`' | '~'
      if (fenceChar === null) {
        fenceChar = markerChar
        fenceLength = marker.length
        continue
      }
      if (markerChar === fenceChar && marker.length >= fenceLength) {
        fenceChar = null
        fenceLength = 0
      }
      continue
    }

    if (fenceChar !== null) continue

    const match = line.match(ATX_HEADING_RE)
    if (!match) continue

    const level = match[2].length
    if (level < minLevel || level > maxLevel) continue

    const rawText = match[3].replace(/[ \t]+#+[ \t]*$/, '').trim()
    const text = stripInlineMarkdown(rawText)
    if (text.length === 0) continue

    headings.push({
      id: uniqueId(slugify(text), seen),
      level,
      text,
      line: i + 1,
    })
  }

  return headings
}

export function createHeadingIdRehypePlugin(): (tree: HastNode) => void {
  return (tree: HastNode): void => {
    visitHeadings(tree, new Map())
  }
}
