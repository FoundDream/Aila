interface BrandLogoProps {
  className?: string
}

export function BrandLogo({ className = '' }: BrandLogoProps) {
  const classes = ['brand-lockup', className].filter(Boolean).join(' ')

  return (
    <span className={classes} aria-hidden="true">
      <img className="brand-lockup__image" src="/aila-brand.png" alt="" />
    </span>
  )
}
