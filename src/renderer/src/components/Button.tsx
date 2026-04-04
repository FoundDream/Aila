import type { ButtonHTMLAttributes, ReactElement, ReactNode } from 'react'

type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'ghost'
  | 'quiet'
  | 'quietDanger'
  | 'danger'
  | 'dangerGhost'
type ButtonSize = 'xs' | 'sm' | 'compact' | 'md'

const baseClassName =
  'inline-flex items-center justify-center rounded transition disabled:cursor-not-allowed disabled:opacity-50'

const variantClassNames: Record<ButtonVariant, string> = {
  primary: 'bg-[var(--term-blue)] font-medium text-white hover:bg-[var(--term-blue-strong)]',
  secondary:
    'border border-[var(--term-border)] bg-[var(--term-surface)] text-[var(--term-text-soft)] hover:bg-[var(--term-surface-soft)] hover:text-[var(--term-text)]',
  ghost: 'text-[var(--term-dim)] hover:bg-[var(--term-surface)] hover:text-[var(--term-text)]',
  quiet: 'text-[var(--term-dim)] hover:text-[var(--term-text)]',
  quietDanger: 'text-[var(--term-dim)] hover:text-[var(--term-red)]',
  danger: 'border border-[#e4c7ca] bg-[#fff4f4] text-[var(--term-red)] hover:bg-[#fdeaea]',
  dangerGhost: 'text-[var(--term-red)] hover:text-[#a94a52]',
}

const sizeClassNames: Record<ButtonSize, string> = {
  xs: 'px-2 py-1 text-[11px]',
  sm: 'px-3 py-1.5 text-[11px]',
  compact: 'px-3 py-2 text-[12px]',
  md: 'h-10 px-3 text-[12px]',
}

export function Button({
  children,
  className,
  fullWidth = false,
  size = 'sm',
  type = 'button',
  variant = 'secondary',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode
  className?: string
  fullWidth?: boolean
  size?: ButtonSize
  variant?: ButtonVariant
}): ReactElement {
  return (
    <button
      type={type}
      className={[
        baseClassName,
        variantClassNames[variant],
        sizeClassNames[size],
        fullWidth ? 'w-full' : '',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
      {...props}
    >
      {children}
    </button>
  )
}
