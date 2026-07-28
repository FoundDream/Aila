import { DownloadCluster } from './DownloadCluster'

export function Hero() {
  return (
    <section className="hero">
      <div className="hero-canvas">
        <div className="hero-copy">
          <h1 className="hero-title">
            <span className="hero-title-serif">The local-first runtime</span>
            <span className="hero-title-sans">for human-agent teams.</span>
          </h1>
          <p className="hero-subtitle">
            Aila is a fully open-source agent runtime and workbench for code, documents, and
            personal workflows. One durable engine powers the Desktop app, the TUI, and the CLI —
            your data never leaves your machine.
          </p>
        </div>
      </div>
      <div className="home-container">
        <DownloadCluster id="download" />
      </div>
    </section>
  )
}
