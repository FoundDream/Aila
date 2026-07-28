const githubUrl = 'https://github.com/aila-hq/aila'

interface DownloadClusterProps {
  id?: string
  reveal?: boolean
}

export function DownloadCluster({ id, reveal = false }: DownloadClusterProps) {
  return (
    <div className={`download-cluster${reveal ? ' reveal' : ''}`} id={id}>
      <div className="primary-download-wrap">
        <a className="primary-download" href={githubUrl} target="_blank" rel="noopener">
          <span className="download-label">Get Started</span>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            width="16"
            height="16"
            aria-hidden="true"
          >
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </a>
      </div>
      <p className="also-label">Also available</p>
      <div className="platform-row">
        <a className="platform-pill" href="#download">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M17.05 12.54c-.03-2.89 2.36-4.27 2.47-4.34-1.35-1.97-3.44-2.24-4.18-2.27-1.78-.18-3.47 1.05-4.37 1.05-.9 0-2.29-1.02-3.77-1-1.94.03-3.72 1.13-4.72 2.86-2.01 3.49-.51 8.66 1.45 11.49.96 1.39 2.1 2.94 3.6 2.88 1.45-.06 2-.93 3.75-.93s2.25.93 3.77.9c1.56-.03 2.55-1.41 3.5-2.8 1.1-1.61 1.55-3.17 1.58-3.25-.04-.02-3.03-1.16-3.08-4.59zM14.16 4.06c.8-.97 1.34-2.32 1.19-3.66-1.15.05-2.55.77-3.38 1.74-.74.85-1.39 2.23-1.22 3.54 1.29.1 2.6-.65 3.41-1.62z" />
          </svg>
          <span>macOS</span>
        </a>
        <a className="platform-pill" href="#download">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M3 5.5 10.5 4.4v7.1H3V5.5zm0 13 7.5 1.1v-7.1H3v6zm8.5 1.3L21 21v-8.4h-9.5v7.2zm0-15.6v7.2H21V3l-9.5 1.2z" />
          </svg>
          <span>Windows</span>
        </a>
        <a className="platform-pill" href="#download">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
          </svg>
          <span>Linux</span>
        </a>
        <a className="platform-pill" href="#download">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M7 9l3 3-3 3M12 15h5" />
          </svg>
          <span className="mono">bun run tui</span>
        </a>
        <a className="platform-pill" href="#download">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path d="M4 17l6-5-6-5M12 19h8" />
          </svg>
          <span className="mono">bun run cli</span>
        </a>
      </div>
    </div>
  )
}
