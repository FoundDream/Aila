import { DownloadCluster } from './DownloadCluster'

export function Hero() {
  return (
    <section className="hero">
      <div className="hero-canvas">
        <div className="hero-copy">
          <h1 className="hero-title">
            <span className="hero-title-serif">Your AI workbench,</span>
            <span className="hero-title-sans">built for real projects.</span>
          </h1>
          <p className="hero-subtitle">
            Aila brings durable agent sessions, local tools, and model choice to one open-source
            workbench. Use it from Desktop, the terminal, or scripts, with conversation history
            stored on your machine.
          </p>
        </div>
      </div>
      <div className="home-container">
        <DownloadCluster id="download" />
      </div>
    </section>
  )
}
