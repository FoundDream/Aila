import type { ReactElement } from 'react'

import { DragRegion } from '@/components/DragRegion'

export function HeaderBar(): ReactElement {
  return <DragRegion as="header" className="bg-[var(--term-bg)]" />
}
