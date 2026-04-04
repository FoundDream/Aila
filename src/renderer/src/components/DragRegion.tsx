import type { ReactElement } from 'react'

export function DragRegion({
  as = 'div',
  className = '',
}: {
  as?: 'div' | 'header'
  className?: string
}): ReactElement {
  const Tag = as

  return <Tag className={`h-8 pl-20 [-webkit-app-region:drag] select-none ${className}`.trim()} />
}
