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
          <span className="download-label">View on GitHub</span>
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
      <p className="also-label">Run from source</p>
      <div className="platform-row">
        <a
          className="platform-pill"
          href={`${githubUrl}#interfaces`}
          target="_blank"
          rel="noopener"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path d="M3 4h18v14H3zM8 22h8M12 18v4" />
          </svg>
          <span className="mono">bun run dev</span>
        </a>
        <a
          className="platform-pill"
          href={`${githubUrl}#interfaces`}
          target="_blank"
          rel="noopener"
        >
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
        <a
          className="platform-pill"
          href={`${githubUrl}#interfaces`}
          target="_blank"
          rel="noopener"
        >
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
