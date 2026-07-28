import { BrandLogo } from './BrandLogo'

const githubUrl = 'https://github.com/aila-hq/aila'

const footerColumns = [
  {
    title: 'Product',
    links: [
      ['Desktop', '#why'],
      ['TUI', '#why'],
      ['CLI', '#why'],
      ['Runtime SDK', '#architecture'],
      ['Models', '#models'],
    ],
  },
  {
    title: 'Resources',
    links: [
      ['README', `${githubUrl}#readme`],
      ['Run from source', `${githubUrl}#interfaces`],
      ['Source code', githubUrl],
      ['Releases', `${githubUrl}/releases`],
    ],
  },
  {
    title: 'Community',
    links: [
      ['GitHub', githubUrl],
      ['Issues', `${githubUrl}/issues`],
      ['Discussions', `${githubUrl}/discussions`],
    ],
  },
  {
    title: 'Project',
    links: [
      ['Architecture notes', `${githubUrl}/blob/main/CLAUDE.md`],
      ['Early-stage status', `${githubUrl}#aila`],
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

export function Footer() {
  return (
    <footer className="footer">
      <div className="footer-inner">
        <div className="footer-top reveal">
          <div className="footer-brand">
            <a className="footer-logo" href="#top" aria-label="Aila home">
              <BrandLogo className="footer-brand-lockup" />
            </a>
            <p className="footer-tagline">
              An open-source AI agent workbench with local conversation storage, durable sessions,
              and Desktop, TUI, and CLI interfaces.
            </p>
            <ul className="footer-social">
              <li>
                <a href={githubUrl} target="_blank" rel="noopener" aria-label="GitHub">
                  <GitHubIcon />
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
                        {...(href.startsWith('http')
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
          <p>© 2026 Aila. Open source and under active development.</p>
          <nav className="footer-legal">
            <a href={githubUrl} target="_blank" rel="noopener">
              Source
            </a>
            <a href={`${githubUrl}/issues`} target="_blank" rel="noopener">
              Report an issue
            </a>
          </nav>
        </div>
      </div>
    </footer>
  )
}
