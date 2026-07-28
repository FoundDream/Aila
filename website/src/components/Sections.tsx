import type { ReactNode } from 'react'
import { DownloadCluster } from './DownloadCluster'
import { WindowTitleBar } from './WindowTitleBar'

function ExternalArrow() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      width="14"
      height="14"
      aria-hidden="true"
    >
      <path d="M7 17L17 7M9 7h8v8" />
    </svg>
  )
}

const interfaceItems = [
  {
    iconClass: 'i-desktop',
    name: 'Desktop',
    description: 'interactive workbench · sessions',
    icon: (
      <>
        <rect x="2" y="4" width="20" height="14" rx="2" />
        <path d="M8 22h8M12 18v4" />
      </>
    ),
  },
  {
    iconClass: 'i-tui',
    name: 'TUI',
    description: 'full-screen terminal',
    icon: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M7 9l3 3-3 3M12 15h5" />
      </>
    ),
  },
  {
    iconClass: 'i-cli',
    name: 'CLI',
    description: 'scripts · NDJSON events',
    icon: <path d="M4 17l6-5-6-5M12 19h8" />,
  },
] as const

function InterfaceDemo() {
  return (
    <>
      <div className="demo-interfaces">
        {interfaceItems.map((item) => (
          <div className="demo-iface" key={item.name}>
            <span className={`demo-iface-icon ${item.iconClass}`}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                {item.icon}
              </svg>
            </span>
            <div>
              <div className="demo-iface-name">{item.name}</div>
              <div className="demo-iface-sub">{item.description}</div>
            </div>
            <span className="demo-iface-link">
              <ExternalArrow />
            </span>
          </div>
        ))}
      </div>
      <div className="demo-core">
        <span className="pulse" />
        @aila/agent — sessions · tools · events
      </div>
    </>
  )
}

interface UseCaseProps {
  eyebrow: string
  title: string
  description: string
  reverse?: boolean
  children: ReactNode
}

function UseCase({ eyebrow, title, description, reverse = false, children }: UseCaseProps) {
  return (
    <article className={`usecase-card${reverse ? ' usecase-card--reverse' : ''} reveal`}>
      <div className="uc-heading">
        <span className="uc-eyebrow">{eyebrow}</span>
        <h3>{title}</h3>
        <p className="uc-desc">{description}</p>
      </div>
      <div className="uc-demo">{children}</div>
    </article>
  )
}

export function WhySection() {
  return (
    <section className="section section--why" id="why">
      <div className="home-container">
        <h2 className="section-title reveal">
          One workbench, <span className="title-serif">wherever you work.</span>
        </h2>
        <p className="section-sub reveal">
          Aila keeps conversations, tools, and run state together. Move between Desktop, TUI, and
          CLI without learning three different systems.
        </p>
        <div className="usecase-list">
          <UseCase
            eyebrow="Shared core"
            title="Three interfaces. One set of capabilities."
            description="Desktop, TUI, and CLI use the same runtime, tool contract, and event model. Work interactively, stay in the terminal, or call Aila from a script."
          >
            <InterfaceDemo />
          </UseCase>
          <UseCase
            eyebrow="Durable sessions"
            title="Resume work without rebuilding context."
            description="Aila journals conversation state to disk. Reopen a session, retry an interrupted last turn, or continue from a known conversation ID."
            reverse
          >
            <div className="demo-term">
              <div className="t-cmd">bun run tui -- --resume</div>
              <div className="t-out">restored latest conversation · 14 turns</div>
              <div className="t-out">conversation state loaded from local journal</div>
              <div className="t-ok">▶ session ready · waiting for input</div>
              <div className="t-cmd">bun run cli -- --resume --retry-last --json</div>
              <div className="t-ok">✓ retry started · runtime events streaming</div>
            </div>
          </UseCase>
          <UseCase
            eyebrow="Steerable"
            title="Add the next instruction while a turn runs."
            description="Queue a follow-up, steer an active turn, or abort when needed. Input queues are part of the runtime, so interfaces do not need to fake the behavior."
          >
            <div className="demo-steer">
              <div className="bubble agent">
                Reading the workspace and mapping the affected files.
              </div>
              <div className="bubble user">Also check the CLI entrypoint before you finish.</div>
              <div className="bubble queued">
                <span className="badge">Queued</span>
                Will join the active turn
              </div>
              <div className="bubble agent">Added the CLI entrypoint to the review.</div>
              <div className="bubble agent">
                Done. The affected paths and follow-ups are summarized.
              </div>
            </div>
          </UseCase>
        </div>
      </div>
    </section>
  )
}

const architectureItems = [
  {
    title: 'WorkbenchRuntime',
    description:
      'Coordinates conversations and shared services across a process: storage, host integrations, tools, skills, recovery, and shutdown.',
    tag: 'process scope',
    icon: (
      <>
        <rect x="3" y="3" width="8" height="8" rx="2" />
        <rect x="13" y="3" width="8" height="8" rx="2" />
        <rect x="3" y="13" width="8" height="8" rx="2" />
        <rect x="13" y="13" width="8" height="8" rx="2" />
      </>
    ),
  },
  {
    title: 'SessionRuntime',
    description:
      'Owns one durable conversation: context, navigation, compaction, turn state, event subscriptions, and input queues.',
    tag: 'conversation scope',
    icon: (
      <>
        <path d="M21 12a8 8 0 0 1-8 8H4l2-3a8 8 0 1 1 15-5z" />
        <path d="M9 11h6M9 14h3" />
      </>
    ),
  },
  {
    title: 'AgentRuntime & RunMachine',
    description:
      'Drive one model/tool loop while preserving the execution state needed for events, policy decisions, retry, and recovery.',
    tag: 'turn scope',
    icon: (
      <>
        <path d="M12 2v4M12 18v4M4.9 4.9l2.9 2.9M16.2 16.2l2.9 2.9M2 12h4M18 12h4M4.9 19.1l2.9-2.9M16.2 7.8l2.9-2.9" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
  },
] as const

export function ArchitectureSection() {
  return (
    <section className="section section--architecture" id="architecture">
      <div className="home-container">
        <h2 className="section-title reveal">
          <span>Clear scopes,</span> <span className="title-serif">durable state.</span>
        </h2>
        <p className="section-sub reveal">
          The runtime separates process, conversation, and turn responsibilities so each layer stays
          inspectable and replaceable.
        </p>
        <div className="collab-grid">
          {architectureItems.map((item) => (
            <article className="collab-card reveal" key={item.title}>
              <span className="collab-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  {item.icon}
                </svg>
              </span>
              <h3>{item.title}</h3>
              <p>{item.description}</p>
              <span className="tag">{item.tag}</span>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}

const interfaceModels = [
  ['D', 'Desktop', 'linear-gradient(135deg,#111,#555)'],
  ['T', 'TUI', 'linear-gradient(135deg,#0e9f6e,#5ed3a5)'],
  ['C', 'CLI', 'linear-gradient(135deg,#2556b6,#6a9bf5)'],
  ['S', 'Runtime SDK', 'linear-gradient(135deg,#7c3aed,#c4b5fd)'],
] as const

const modelProviders = [
  ['A', 'Anthropic', '#d97706'],
  ['O', 'OpenAI', '#059669'],
  ['G', 'Google', '#2563eb'],
  ['D', 'DeepSeek', '#4f46e5'],
  ['R', 'OpenRouter', '#7c3aed'],
] as const

function ModelGroup({
  label,
  items,
}: {
  label: string
  items: ReadonlyArray<readonly [string, string, string]>
}) {
  return (
    <div className="models-group">
      <span className="models-group-label">{label}</span>
      <div className="model-chips">
        {items.map(([initial, name, background]) => (
          <span className="model-chip" key={name}>
            <span className="model-chip__logo" style={{ background }}>
              {initial}
            </span>
            {name}
          </span>
        ))}
        {label === 'Providers' ? (
          <span className="model-chip model-chip--dashed">More via OpenRouter</span>
        ) : null}
      </div>
    </div>
  )
}

export function ModelsSection() {
  return (
    <section className="section section--models" id="models">
      <div className="home-container">
        <h2 className="section-title reveal">
          Choose the model <span className="title-serif">for the task.</span>
        </h2>
        <p className="section-sub reveal">
          Configure Anthropic, OpenAI, Google, DeepSeek, or OpenRouter, then switch models per
          conversation without changing how Aila works.
        </p>
        <div className="models-board reveal">
          <ModelGroup label="Interfaces" items={interfaceModels} />
          <ModelGroup label="Providers" items={modelProviders} />
        </div>
      </div>
    </section>
  )
}

function ShotBar({ title }: { title: string }) {
  return (
    <div className="shot-bar">
      <i />
      <i />
      <i />
      <span className="shot-title">{title}</span>
    </div>
  )
}

function FeatureCard({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <article className="feature-card reveal">
      <div className="feature-text">
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      <div className="feature-shot">
        <div className="shot" data-parallax>
          {children}
        </div>
      </div>
    </article>
  )
}

export function FeaturesSection() {
  const barHeights = [
    ['38%', true],
    ['55%', true],
    ['70%', false],
    ['52%', false],
    ['88%', false],
    ['64%', false],
    ['96%', false],
  ] as const

  return (
    <section className="features">
      <div className="home-container">
        <h2 className="section-title reveal">
          <span>From quick edits</span> <span className="title-serif">to repeatable runs.</span>
        </h2>
        <div className="feature-grid">
          <FeatureCard
            title="Code changes"
            description="Inspect a repository, edit files, and run commands through the host’s tool policy. You decide when writes and shell commands need approval."
          >
            <ShotBar title="session-store.ts — diff" />
            <div className="shot-body shot-code">
              <div className="c-line">
                <span className="c-no">12</span>
                <span>
                  <span className="c-kw">export class</span> SessionStore {'{'}
                </span>
              </div>
              <div className="c-line del">
                <span className="c-no">13</span>
                <span>- save(msg: any) {'{'}</span>
              </div>
              <div className="c-line add">
                <span className="c-no">13</span>
                <span>+ save(msg: StoredMessage) {'{'}</span>
              </div>
              <div className="c-line add">
                <span className="c-no">14</span>
                <span>+ this.journal.append(msg);</span>
              </div>
              <div className="c-line">
                <span className="c-no">15</span>
                <span>&nbsp;&nbsp;this.index.write(msg);</span>
              </div>
            </div>
          </FeatureCard>
          <FeatureCard
            title="File-aware conversations"
            description="Attach images or files, read project docs, and keep that context with the conversation instead of rebuilding it in every prompt."
          >
            <ShotBar title="onboarding.md" />
            <div className="shot-body shot-doc">
              <h4>Contributor onboarding</h4>
              <div className="line w85" />
              <div className="line w60" />
              <div className="line w70" />
              <div className="check">Runtime scopes documented</div>
              <div className="check">Data directories explained</div>
            </div>
          </FeatureCard>
          <FeatureCard
            title="Review-ready summaries"
            description="Summarize a working tree, explain changes, and produce a handoff that another person or tool can review."
          >
            <ShotBar title="workspace-summary.md" />
            <div className="shot-body shot-report">
              <div className="kpis">
                <div className="kpi">
                  <b>18</b>
                  <span>files changed</span>
                </div>
                <div className="kpi">
                  <b>6</b>
                  <span>risks found</span>
                </div>
                <div className="kpi">
                  <b>4</b>
                  <span>next steps</span>
                </div>
              </div>
              <div className="bars">
                {barHeights.map(([height, dim]) => (
                  <span className={`bar${dim ? ' dim' : ''}`} style={{ height }} key={height} />
                ))}
              </div>
            </div>
          </FeatureCard>
          <FeatureCard
            title="Scriptable runs"
            description="Use the CLI in shell scripts and existing job runners. Stream machine-readable events as NDJSON, and opt into approvals only when automation needs it."
          >
            <ShotBar title="review-changes.sh" />
            <div className="shot-body shot-flow">
              <div className="step">
                <span className="no">1</span>
                git status --short
                <span className="ok">ok</span>
              </div>
              <div className="step">
                <span className="no">2</span>
                bun run cli -- &quot;summarize changes&quot;
                <span className="ok">ok</span>
              </div>
              <div className="step">
                <span className="no">3</span>
                bun run cli -- --events &quot;review risks&quot;
                <span className="ok">ok</span>
              </div>
              <div className="step">
                <span className="no">4</span>
                archive the NDJSON output
                <span className="ok">ok</span>
              </div>
            </div>
          </FeatureCard>
        </div>
      </div>
    </section>
  )
}

const securityItems = [
  {
    title: 'Local conversation storage',
    description:
      'TUI and CLI use ~/.aila by default; Desktop uses its app-data directory. Aila does not require a hosted sync service.',
    icon: <path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7l8-4z" />,
  },
  {
    title: 'Approval is a policy',
    description:
      'CLI denies tool approvals by default. Desktop and TUI surface approval flows; automation can opt in explicitly.',
    icon: (
      <>
        <rect x="4" y="10" width="16" height="10" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3" />
      </>
    ),
  },
  {
    title: 'Machine-readable events',
    description:
      'CLI can stream runtime events as NDJSON, so scripts can capture what happened without scraping terminal output.',
    icon: <path d="M4 6h16M4 12h16M4 18h10" />,
  },
  {
    title: 'Open-source core',
    description:
      'The runtime, Node adapters, Desktop, TUI, and CLI live in one repository, so you can inspect and adapt the code you run.',
    icon: <path d="M8 9l-4 3 4 3M16 9l4 3-4 3M13 5l-2 14" />,
  },
] as const

export function SecuritySection() {
  return (
    <section className="section" id="security">
      <div className="home-container">
        <h2 className="section-title reveal">
          Local state, <span className="title-serif">clear boundaries.</span>
        </h2>
        <p className="section-sub reveal">
          Conversation history is stored locally by default. Model requests still go to the provider
          you configure; Aila itself does not require a hosted conversation service.
        </p>
        <div className="security-grid">
          {securityItems.map((item) => (
            <article className="security-card reveal" key={item.title}>
              <span className="security-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  {item.icon}
                </svg>
              </span>
              <h3>{item.title}</h3>
              <p>{item.description}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}

export function FinalCta() {
  return (
    <section className="final-cta">
      <div className="home-container">
        <h2 className="reveal">
          Try Aila <span className="title-serif">from the source.</span>
        </h2>
        <p className="reveal">
          The project is under active development. Expect rough edges and breaking changes — and
          help shape what comes next on GitHub.
        </p>
        <DownloadCluster reveal />
        <div className="final-cta-shot reveal">
          <WindowTitleBar title="Aila TUI — bun run tui" />
          <div className="demo-term demo-term--cta">
            <div className="t-cmd">bun run tui -- --model openai:gpt-5.4</div>
            <div className="t-out">aila-tui · session 8f3a…c2 · model openai:gpt-5.4</div>
            <div className="t-out">&nbsp;</div>
            <div className="t-cmd t-cmd--accent">/read package.json</div>
            <div className="t-ok">✓ read 46 lines</div>
            <div className="t-cmd t-cmd--accent">/run git status --short</div>
            <div className="t-ok">✓ 3 files changed</div>
            <div className="t-out">&nbsp;</div>
            <div className="t-out">Aila is composing a summary of the working tree…</div>
            <div className="t-out">queue: 1 follow-up waiting · Ctrl+C to abort</div>
          </div>
        </div>
      </div>
    </section>
  )
}
