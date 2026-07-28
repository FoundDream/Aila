interface WindowTitleBarProps {
  title: string
}

export function WindowTitleBar({ title }: WindowTitleBarProps) {
  return (
    <div className="app-titlebar">
      <span className="tl-dot" />
      <span className="tl-dot" />
      <span className="tl-dot" />
      <span className="tl-title">{title}</span>
    </div>
  )
}
