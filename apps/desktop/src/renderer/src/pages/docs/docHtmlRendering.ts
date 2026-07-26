import { defaultRehypePlugins } from 'streamdown'
import type { PluggableList, Plugin } from 'unified'
import { createHeadingIdRehypePlugin } from './markdownHeadings'

type DocsHastNode = {
  type?: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: DocsHastNode[]
}

type DocsSanitizeSchema = {
  ancestors?: Record<string, string[]>
  attributes?: Record<string, unknown[]>
  clobber?: string[]
  clobberPrefix?: string
  protocols?: Record<string, string[]>
  required?: Record<string, Record<string, unknown>>
  strip?: string[]
  tagNames?: string[]
}

const rehypeSanitizePlugin = (
  Array.isArray(defaultRehypePlugins.sanitize)
    ? defaultRehypePlugins.sanitize[0]
    : defaultRehypePlugins.sanitize
) as Plugin<[DocsSanitizeSchema]>

const defaultSanitizeSchema = (
  Array.isArray(defaultRehypePlugins.sanitize) ? defaultRehypePlugins.sanitize[1] : {}
) as DocsSanitizeSchema

function mergeUnique<T>(base: readonly T[] = [], extra: readonly T[] = []): T[] {
  return [...base, ...extra].filter((value, index, all) => all.indexOf(value) === index)
}

function mergeAttributes(
  base: Record<string, unknown[]> | undefined,
  extra: Record<string, unknown[]>,
): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = { ...(base ?? {}) }
  for (const [key, values] of Object.entries(extra)) {
    out[key] = [...(out[key] ?? []), ...values]
  }
  return out
}

export const docsHtmlSanitizeSchema: DocsSanitizeSchema = {
  ...defaultSanitizeSchema,
  attributes: mergeAttributes(defaultSanitizeSchema.attributes, {
    a: ['rel', 'target'],
    img: ['alt', 'title', 'width', 'height'],
    table: ['align'],
    td: ['align', 'colSpan', 'rowSpan'],
    th: ['align', 'colSpan', 'rowSpan', 'scope'],
  }),
  protocols: {
    ...(defaultSanitizeSchema.protocols ?? {}),
    href: mergeUnique(defaultSanitizeSchema.protocols?.href, ['mailto', 'tel']),
    src: mergeUnique(defaultSanitizeSchema.protocols?.src, ['aila-image']),
  },
  strip: mergeUnique(defaultSanitizeSchema.strip, ['script', 'style']),
  tagNames: mergeUnique(defaultSanitizeSchema.tagNames, [
    'caption',
    'col',
    'colgroup',
    'figcaption',
    'figure',
    'mark',
  ]),
}

export const docsRehypePlugins: PluggableList = [
  defaultRehypePlugins.raw,
  [rehypeSanitizePlugin, docsHtmlSanitizeSchema],
  hardenDocsHtmlPlugin,
  createHeadingIdRehypePlugin,
]

function hardenDocsHtmlPlugin(): (tree: DocsHastNode) => void {
  return (tree: DocsHastNode): void => {
    hardenNode(tree)
  }
}

function hardenNode(node: DocsHastNode, parent?: DocsHastNode, index?: number): void {
  if (node.type === 'element') {
    if (node.tagName === 'a') {
      const href = getStringProperty(node, 'href')
      if (!isSafeDocsUrl(href, 'href')) {
        node.tagName = 'span'
        node.properties = {}
      } else {
        node.properties = {
          ...node.properties,
          href,
          ...(isExternalUrl(href) ? { rel: 'noopener noreferrer', target: '_blank' } : {}),
        }
      }
    }

    if (node.tagName === 'img') {
      const src = getStringProperty(node, 'src')
      if (!isSafeDocsUrl(src, 'src')) {
        const alt = getStringProperty(node, 'alt')
        if (parent && typeof index === 'number') {
          if (alt) {
            parent.children?.splice(index, 1, { type: 'text', value: alt })
          } else {
            parent.children?.splice(index, 1)
          }
        }
        return
      }
      node.properties = { ...node.properties, src }
    }
  }

  const children = [...(node.children ?? [])]
  children.forEach((child) => {
    hardenNode(child, node, node.children?.indexOf(child))
  })
}

function getStringProperty(node: DocsHastNode, key: string): string {
  const value = node.properties?.[key]
  return typeof value === 'string' ? value.trim() : ''
}

function isExternalUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

export function isSafeDocsUrl(value: string, key: 'href' | 'src'): boolean {
  if (value.length === 0) return false
  if (key === 'href' && value.startsWith('#')) return true
  const compactValue = stripUrlControlChars(value)
  if (compactValue.startsWith('//')) return false

  const protocolMatch = compactValue.match(/^([a-zA-Z][a-zA-Z\d+.-]*):/)
  if (protocolMatch) {
    const protocol = protocolMatch[1].toLowerCase()
    if (protocol === 'http' || protocol === 'https') return true
    if (key === 'href' && (protocol === 'mailto' || protocol === 'tel')) return true
    return key === 'src' && protocol === 'aila-image'
  }

  return true
}

function stripUrlControlChars(value: string): string {
  let result = ''
  for (const char of value) {
    const code = char.charCodeAt(0)
    if (code > 32 && code !== 127) result += char
  }
  return result
}
