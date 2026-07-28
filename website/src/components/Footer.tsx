const githubUrl = 'https://github.com/aila-hq/aila'

const footerColumns = [
  {
    title: 'Product',
    links: [
      ['Desktop', '#preview'],
      ['TUI', '#preview'],
      ['CLI', '#preview'],
      ['Runtime SDK', '#architecture'],
      ['Models', '#models'],
    ],
  },
  {
    title: 'Resources',
    links: [
      ['Documentation', '#'],
      ['Getting started', '#'],
      ['Changelog', '#'],
      ['Releases', '#'],
    ],
  },
  {
    title: 'Community',
    links: [
      ['GitHub', githubUrl],
      ['Issues', '#'],
      ['Discussions', '#'],
      ['Contributing', '#'],
    ],
  },
  {
    title: 'Project',
    links: [
      ['About', '#'],
      ['Roadmap', '#'],
      ['License (MIT)', '#'],
    ],
  },
] as const

function GitHubIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.27-.01-1.17-.02-2.12-3.2.7-3.88-1.36-3.88-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.75 2.69 1.25 3.34.95.1-.74.4-1.25.72-1.53-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.42-2.7 5.39-5.27 5.68.41.36.78 1.06.78 2.14 0 1.55-.01 2.79-.01 3.17 0 .31.2.68.8.56A10.52 10.52 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z" />
    </svg>
  )
}

function XIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M18.9 2H22l-6.8 7.8L23.3 22h-6.3l-4.9-6.4L6.5 22H3.4l7.3-8.3L1.5 2h6.4l4.4 5.9L18.9 2zm-1.1 18h1.7L7.1 3.9H5.3L17.8 20z" />
    </svg>
  )
}

function DiscordIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M20.3 4.4A19.8 19.8 0 0 0 15.4 3c-.2.4-.5.9-.6 1.3a18.3 18.3 0 0 0-5.5 0C9 3.9 8.8 3.4 8.6 3a19.7 19.7 0 0 0-4.9 1.5A20.4 20.4 0 0 0 .2 18.1a19.9 19.9 0 0 0 6 3c.5-.7.9-1.4 1.3-2.1-.7-.3-1.4-.6-2-1l.5-.4a14.2 14.2 0 0 0 12.1 0l.5.4c-.6.4-1.3.7-2 1 .4.7.8 1.4 1.3 2.1a19.8 19.8 0 0 0 6-3A20.3 20.3 0 0 0 20.3 4.4zM8 15.3c-1.2 0-2.1-1.1-2.1-2.4S6.8 10.5 8 10.5s2.2 1.1 2.1 2.4c0 1.3-.9 2.4-2.1 2.4zm8 0c-1.2 0-2.1-1.1-2.1-2.4s.9-2.4 2.1-2.4 2.2 1.1 2.1 2.4c0 1.3-.9 2.4-2.1 2.4z" />
    </svg>
  )
}

export function Footer() {
  return (
    <footer className="footer">
      <div className="footer-inner">
        <div className="footer-top reveal">
          <div className="footer-brand">
            <a className="footer-logo" href="#top">
              <span className="nav-logo-mark">A</span>
              <span>Aila</span>
            </a>
            <p className="footer-tagline">
              The open-source, local-first agent runtime and workbench for code, documents, and
              personal workflows.
            </p>
            <ul className="footer-social">
              <li>
                <a href={githubUrl} target="_blank" rel="noopener" aria-label="GitHub">
                  <GitHubIcon />
                </a>
              </li>
              <li>
                <a href="#" aria-label="X">
                  <XIcon />
                </a>
              </li>
              <li>
                <a href="#" aria-label="Discord">
                  <DiscordIcon />
                </a>
              </li>
            </ul>
          </div>
          <div className="footer-cols">
            {footerColumns.map((column) => (
              <div className="footer-col" key={column.title}>
                <h3>{column.title}</h3>
                <ul>
                  {column.links.map(([label, href]) => (
                    <li key={label}>
                      <a
                        href={href}
                        {...(href === githubUrl
                          ? { target: '_blank', rel: 'noopener' }
                          : undefined)}
                      >
                        {label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
        <div className="footer-bottom reveal">
          <p>© 2026 The Aila Project. Open source under the MIT License.</p>
          <nav className="footer-legal">
            <a href="#">Privacy</a>
            <a href="#">Terms</a>
          </nav>
        </div>
      </div>
    </footer>
  )
}
