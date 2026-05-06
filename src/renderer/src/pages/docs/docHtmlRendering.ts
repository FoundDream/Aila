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

const htmlSanitizeSchema = {
  attributes: {
    a: ['href', 'title', 'target', 'rel'],
    code: [['className', /^language-./]],
    img: ['src', 'alt', 'title', 'width', 'height'],
    ol: ['start'],
    table: ['align'],
    td: ['align', 'colSpan', 'rowSpan'],
    th: ['align', 'colSpan', 'rowSpan', 'scope'],
    '*': ['ariaLabel', 'ariaLabelledBy', 'ariaDescribedBy', 'dir', 'lang', 'open', 'title'],
  },
  clobber: ['ariaDescribedBy', 'ariaLabelledBy', 'id', 'name'],
  clobberPrefix: 'user-content-',
  protocols: {
    href: ['http', 'https'],
    src: ['http', 'https'],
  },
  strip: ['script', 'style'],
  tagNames: [
    'a',
    'b',
    'blockquote',
    'br',
    'code',
    'del',
    'details',
    'div',
    'em',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'hr',
    'i',
    'img',
    'ins',
    'kbd',
    'li',
    'mark',
    'ol',
    'p',
    'pre',
    's',
    'span',
    'strike',
    'strong',
    'sub',
    'summary',
    'sup',
    'table',
    'tbody',
    'td',
    'tfoot',
    'th',
    'thead',
    'tr',
    'ul',
  ],
}

const rehypeSanitizePlugin = (
  Array.isArray(defaultRehypePlugins.sanitize)
    ? defaultRehypePlugins.sanitize[0]
    : defaultRehypePlugins.sanitize
) as Plugin<[typeof htmlSanitizeSchema]>

export const docsRehypePlugins: PluggableList = [
  defaultRehypePlugins.raw,
  [rehypeSanitizePlugin, htmlSanitizeSchema],
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

function isSafeDocsUrl(value: string, key: 'href' | 'src'): boolean {
  if (value.length === 0) return false
  if (key === 'href' && value.startsWith('#')) return true
  const compactValue = stripUrlControlChars(value)
  if (compactValue.startsWith('//')) return false

  const protocolMatch = compactValue.match(/^([a-zA-Z][a-zA-Z\d+.-]*):/)
  if (protocolMatch) {
    return protocolMatch[1].toLowerCase() === 'http' || protocolMatch[1].toLowerCase() === 'https'
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
