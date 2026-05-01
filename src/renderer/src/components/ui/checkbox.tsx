'use client'

import { cn } from '@/lib/utils'
import type { ComponentProps, ReactElement } from 'react'

export type CheckboxProps = Omit<ComponentProps<'input'>, 'type'> & {
  checked?: boolean
  onCheckedChange?: (checked: boolean) => void
}

export function Checkbox({
  className,
  checked,
  onCheckedChange,
  onChange,
  ...props
}: CheckboxProps): ReactElement {
  return (
    <input
      {...props}
      type="checkbox"
      checked={checked}
      onChange={(event) => {
        onCheckedChange?.(event.target.checked)
        onChange?.(event)
      }}
      className={cn(
        'size-4 cursor-pointer appearance-none rounded-sm border border-input bg-background',
        'checked:border-primary checked:bg-primary',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'relative checked:after:absolute checked:after:left-[3px] checked:after:top-[0px] checked:after:text-[10px] checked:after:font-bold checked:after:text-primary-foreground checked:after:content-["✓"]',
        className,
      )}
    />
  )
}
