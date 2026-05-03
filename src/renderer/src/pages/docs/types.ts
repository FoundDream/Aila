export type DocContent = string

export interface DocSummary {
  id: string
  folderPath: string | null
  title: string
  createdAt: number
  updatedAt: number
}

export interface DocRecord extends DocSummary {
  content: DocContent
}

export interface FolderSummary {
  path: string
  name: string
  parentPath: string | null
}

export const EMPTY_DOC_CONTENT: DocContent = ''
