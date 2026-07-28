import { useEffect, useRef } from 'react'
import { WindowTitleBar } from './WindowTitleBar'

const conversations = [
  {
    avatar: 'AI',
    avatarClass: 'a1',
    name: 'Repo onboarding',
    time: '20:22',
    preview: 'Added the runtime scopes section.',
  },
  {
    avatar: 'WR',
    avatarClass: 'a2',
    name: 'Weekly report',
    time: '19:53',
    preview: 'KPI summary is ready for review.',
  },
  {
    avatar: 'DP',
    avatarClass: 'a3',
    name: 'Docs polish',
    time: '16:20',
    preview: 'Two sections need a second pass.',
  },
  {
    avatar: 'RP',
    avatarClass: 'a4',
    name: 'Refactor plan',
    time: '13:26',
    preview: 'Splitting the session store next.',
  },
  {
    avatar: 'CA',
    avatarClass: 'a5',
    name: 'CLI automation',
    time: '12:10',
    preview: 'Nightly job emits NDJSON events.',
  },
] as const

function AppRail() {
  return (
    <nav className="app-rail" aria-hidden="true">
      <span className="rail-avatar">Z</span>
      <button className="rail-btn is-active" type="button" tabIndex={-1} title="Chat">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 12a8 8 0 0 1-8 8H4l2-3a8 8 0 1 1 15-5z" />
        </svg>
      </button>
      <button className="rail-btn" type="button" tabIndex={-1} title="Docs">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6z" />
          <path d="M14 3v6h6" />
        </svg>
      </button>
      <button className="rail-btn" type="button" tabIndex={-1} title="Extensions">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="4" y="4" width="7" height="7" rx="1.5" />
          <rect x="13" y="4" width="7" height="7" rx="1.5" />
          <rect x="4" y="13" width="7" height="7" rx="1.5" />
          <rect x="13" y="13" width="7" height="7" rx="1.5" />
        </svg>
      </button>
      <span className="rail-spacer" />
      <button className="rail-btn" type="button" tabIndex={-1} title="Settings">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
    </nav>
  )
}

function AppSidebar() {
  return (
    <aside className="app-sidebar">
      <div className="sidebar-head">
        <h2>Conversations</h2>
        <span className="icon-btn">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            width="15"
            height="15"
            aria-hidden="true"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
        </span>
      </div>
      <div className="sidebar-search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4.3-4.3" />
        </svg>
        <span>Search</span>
      </div>
      <div className="convo-list">
        {conversations.map((conversation, index) => (
          <button
            className={`convo${index === 0 ? ' is-active' : ''}`}
            type="button"
            key={conversation.name}
          >
            <span className={`convo-avatar ${conversation.avatarClass}`}>
              {conversation.avatar}
            </span>
            <span className="convo-copy">
              <span className="convo-line">
                <span className="convo-name">{conversation.name}</span>
                <span className="convo-time">{conversation.time}</span>
              </span>
              <span className="convo-preview">{conversation.preview}</span>
            </span>
          </button>
        ))}
      </div>
    </aside>
  )
}

function ToolCall({ kind, children }: { kind: 'file' | 'terminal'; children: React.ReactNode }) {
  return (
    <div className="tool-call">
      {kind === 'file' ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6z" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M4 17l6-5-6-5M12 19h8" />
        </svg>
      )}
      {children}
      <span className="ok">done</span>
    </div>
  )
}

function ArtifactCard() {
  return (
    <div className="artifact">
      <div className="artifact-head">
        <span className="artifact-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6z" />
            <path d="M14 3v6h6" />
          </svg>
        </span>
        <div>
          <div className="artifact-title">docs/onboarding.md — Draft</div>
          <div className="artifact-sub">Prepared by Aila · pending your review</div>
        </div>
      </div>
      <div className="artifact-body">
        <ul>
          <li>Project layout: apps/*, packages/*</li>
          <li>Checks: lint, typecheck, test, build</li>
          <li>Data dirs: ~/.aila and .dev-data</li>
        </ul>
      </div>
      <div className="artifact-stats">
        <div className="artifact-stat">
          <b>4</b>
          <span>sections</span>
        </div>
        <div className="artifact-stat">
          <b>2</b>
          <span>tools used</span>
        </div>
        <div className="artifact-stat">
          <b>1</b>
          <span>draft</span>
        </div>
      </div>
    </div>
  )
}

function AppChat() {
  return (
    <div className="app-chat">
      <div className="chat-head">
        <span className="convo-avatar a1">AI</span>
        <div>
          <div className="chat-head-title">Repo onboarding</div>
          <div className="chat-head-sub">Aila agent · 3 tools used · turn active</div>
        </div>
      </div>
      <div className="chat-scroll">
        <div className="msg msg--user">
          <span
            className="msg-avatar"
            style={{ background: 'linear-gradient(135deg,#2556b6,#6a9bf5)' }}
          >
            Z
          </span>
          <div className="msg-body">
            <div className="msg-name">You</div>
            <div className="msg-text">
              Summarize this repo and draft an onboarding doc for new contributors.
            </div>
          </div>
        </div>
        <div className="msg">
          <span className="msg-avatar" style={{ background: 'linear-gradient(135deg,#111,#555)' }}>
            AI
          </span>
          <div className="msg-body">
            <div className="msg-name">Aila</div>
            <div className="msg-text">I’ll scan the workspace first, then draft the doc.</div>
            <ToolCall kind="file">/read README.md</ToolCall>
            <ToolCall kind="terminal">/run git ls-files | head -40</ToolCall>
            <ArtifactCard />
          </div>
        </div>
        <div className="msg msg--user">
          <span
            className="msg-avatar"
            style={{ background: 'linear-gradient(135deg,#2556b6,#6a9bf5)' }}
          >
            Z
          </span>
          <div className="msg-body">
            <div className="msg-name">You</div>
            <div className="msg-text">Add a section on the runtime scopes.</div>
          </div>
        </div>
        <div className="msg">
          <span className="msg-avatar" style={{ background: 'linear-gradient(135deg,#111,#555)' }}>
            AI
          </span>
          <div className="msg-body">
            <div className="msg-name">Aila</div>
            <div className="msg-text">
              Done — documented the three scopes with their responsibilities.
            </div>
            <div className="diff">
              <div className="diff-line add">+ ## Runtime scopes</div>
              <div className="diff-line add">+ WorkbenchRuntime — multi-session facade</div>
              <div className="diff-line add">+ SessionRuntime — per-conversation lifecycle</div>
              <div className="diff-line add">+ AgentRuntime — one model/tool loop</div>
            </div>
          </div>
        </div>
      </div>
      <div className="chat-composer">
        <span className="placeholder">Message Aila, or queue a follow-up while it works…</span>
        <span className="composer-send">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        </span>
      </div>
    </div>
  )
}

export function ProductPreview() {
  const sectionRef = useRef<HTMLElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const section = sectionRef.current
    const frame = frameRef.current
    if (!section || !frame) {
      return
    }

    const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)')
    let animationFrame = 0

    const syncPreview = () => {
      animationFrame = 0

      if (motionPreference.matches || window.innerWidth < 1024) {
        frame.style.removeProperty('--preview-scale')
        frame.style.removeProperty('--preview-y')
        return
      }

      const bounds = section.getBoundingClientRect()
      const animationStart = window.innerHeight * 0.98
      const animationDistance = window.innerHeight * 0.88
      const progress = Math.min(Math.max((animationStart - bounds.top) / animationDistance, 0), 1)

      frame.style.setProperty('--preview-scale', (0.9 + progress * 0.1).toFixed(4))
      frame.style.setProperty('--preview-y', `${(-42 * progress).toFixed(2)}px`)
    }

    const requestSync = () => {
      if (animationFrame === 0) {
        animationFrame = window.requestAnimationFrame(syncPreview)
      }
    }

    syncPreview()
    window.addEventListener('scroll', requestSync, { passive: true })
    window.addEventListener('resize', requestSync)
    motionPreference.addEventListener('change', requestSync)

    return () => {
      if (animationFrame !== 0) {
        window.cancelAnimationFrame(animationFrame)
      }
      window.removeEventListener('scroll', requestSync)
      window.removeEventListener('resize', requestSync)
      motionPreference.removeEventListener('change', requestSync)
    }
  }, [])

  return (
    <section className="product-preview" id="preview" ref={sectionRef}>
      <div className="product-preview-track">
        <div className="product-preview-sticky">
          <div className="home-container">
            <div className="app-frame-reveal reveal">
              <div className="app-frame" ref={frameRef}>
                <WindowTitleBar title="Aila Desktop — workbench" />
                <div className="app-body">
                  <AppRail />
                  <AppSidebar />
                  <AppChat />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
