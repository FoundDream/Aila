import type { Value } from 'platejs'

export type DocContent = Value

export interface DocSummary {
  id: string
  parentId: string | null
  title: string
  createdAt: number
  updatedAt: number
}

export interface DocRecord extends DocSummary {
  content: DocContent
}

export const EMPTY_DOC_CONTENT: DocContent = [{ type: 'p', children: [{ text: '' }] }]
