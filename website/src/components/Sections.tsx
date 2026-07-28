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
    description: 'workbench · docs · sessions',
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
    description: 'full-screen terminal adapter',
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
    description: 'scripts · automation · NDJSON',
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
        @aila/agent — AgentRuntime · tools · storage · events
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
          Why a runtime, <span className="title-serif">not another chat app?</span>
        </h2>
        <p className="section-sub reveal">
          Most agent tools stop at the conversation. Aila owns the whole lifecycle — sessions,
          tools, persistence, and recovery — in one open engine.
        </p>
        <div className="usecase-list">
          <UseCase
            eyebrow="One engine"
            title="Desktop, TUI, and CLI share the same runtime."
            description="Every interface is a thin adapter over the shared AgentRuntime — same tools, same storage, same event contract. Start a task in the terminal, review it on the Desktop, automate it from a script."
          >
            <InterfaceDemo />
          </UseCase>
          <UseCase
            eyebrow="Durable by default"
            title="Every turn survives a restart."
            description="Turns are journaled to disk as they run. Close the app mid-turn, crash the machine, lose power — resume exactly where you left off with one flag."
            reverse
          >
            <div className="demo-term">
              <div className="t-cmd">bun run tui -- --resume --retry-last</div>
              <div className="t-out">restored conversation 8f3a…c2 · 14 turns</div>
              <div className="t-out">found persisted user message without response</div>
              <div className="t-ok">▶ resuming last turn — queue intact</div>
              <div className="t-cmd">bun run cli -- --resume --json &quot;continue&quot;</div>
              <div className="t-ok">✓ turn completed · events written to journal</div>
            </div>
          </UseCase>
          <UseCase
            eyebrow="Steerable"
            title="Queue follow-ups while the agent works."
            description="Don’t wait for the turn to end. Steer the current run, line up the next instruction, or abort cleanly — input queues are part of the runtime, not a UI trick."
          >
            <div className="demo-steer">
              <div className="bubble agent">
                Running the test suite across packages now — 6 contract suites queued.
              </div>
              <div className="bubble user">While that runs: also check the CLI contract.</div>
              <div className="bubble queued">
                <span className="badge">Queued</span>
                Will steer into the active turn
              </div>
              <div className="bubble agent">
                Picked up your steer mid-turn. Adding the CLI contract to the run.
              </div>
              <div className="bubble agent">All 7 suites green. Summary posted above.</div>
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
      'The multi-session process facade. It creates, retains, routes, recovers, and shuts down session runtimes — backed by one shared service container.',
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
      'Bound to one durable conversation. Owns turn lifecycle, pending journal writes, context assembly, compaction, and the steer / follow-up input queues.',
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
      'AgentRuntime orchestrates one model/tool loop with queue timing and step policy. RunMachine is the pure, durable execution state machine underneath it.',
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
          <span>Designed to</span> <span className="title-serif">run forever.</span>
        </h2>
        <p className="section-sub reveal">
          Explicit scopes, each with one job. The architecture is the documentation — and it’s all
          open.
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
  ['C', 'Claude', '#d97706'],
  ['G', 'GPT', '#059669'],
  ['G', 'Gemini', '#2563eb'],
  ['K', 'Kimi', '#111827'],
  ['D', 'DeepSeek', '#4f46e5'],
  ['Q', 'Qwen', '#7c2d12'],
  ['O', 'Ollama', '#0f766e'],
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
        {label === 'Models' ? (
          <span className="model-chip model-chip--dashed">Bring your own</span>
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
          One runtime, <span className="title-serif">every model.</span>
        </h2>
        <p className="section-sub reveal">
          Swap models per session without changing tools, storage, or habits. Bring your own
          provider keys — or your own provider.
        </p>
        <div className="models-board reveal">
          <ModelGroup label="Interfaces" items={interfaceModels} />
          <ModelGroup label="Models" items={modelProviders} />
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
          <span>Real work</span> <span className="title-serif">your agents can ship.</span>
        </h2>
        <div className="feature-grid">
          <FeatureCard
            title="Code changes"
            description="Reads, edits, and runs checks inside your real repo — with an approval gate before anything touches disk."
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
            title="Documents"
            description="Draft, revise, and polish docs in the Desktop workbench — the agent writes where you read."
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
            title="Reports"
            description="Recurring summaries and KPI digests, generated on a schedule from the CLI — review them anywhere."
          >
            <ShotBar title="weekly-report — 07:00 cron" />
            <div className="shot-body shot-report">
              <div className="kpis">
                <div className="kpi">
                  <b>128</b>
                  <span>commits</span>
                </div>
                <div className="kpi">
                  <b>42</b>
                  <span>PRs merged</span>
                </div>
                <div className="kpi">
                  <b>99.2%</b>
                  <span>checks green</span>
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
            title="Personal workflows"
            description="Chain prompts, tools, and scripts into repeatable jobs — same runtime, headless when you need it."
          >
            <ShotBar title="nightly.pipeline" />
            <div className="shot-body shot-flow">
              <div className="step">
                <span className="no">1</span>
                git pull --rebase
                <span className="ok">ok</span>
              </div>
              <div className="step">
                <span className="no">2</span>
                aila cli &quot;summarize changes&quot;
                <span className="ok">ok</span>
              </div>
              <div className="step">
                <span className="no">3</span>
                aila cli --events &gt; log.ndjson
                <span className="ok">ok</span>
              </div>
              <div className="step">
                <span className="no">4</span>
                post digest to inbox
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
    title: 'Local-first storage',
    description:
      'Conversations and settings live in ~/.aila on your machine. Nothing syncs anywhere unless you make it.',
    icon: <path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7l8-4z" />,
  },
  {
    title: 'Explicit approvals',
    description:
      'Tool executions are denied by default in the CLI. Auto-approval is a deliberate, per-run opt-in.',
    icon: (
      <>
        <rect x="4" y="10" width="16" height="10" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3" />
      </>
    ),
  },
  {
    title: 'Auditable events',
    description:
      'Every run can emit a full NDJSON event stream — who did what, when, and why, in a format scripts can read.',
    icon: <path d="M4 6h16M4 12h16M4 18h10" />,
  },
  {
    title: 'Fully open source',
    description:
      'The runtime, the adapters, and the contracts are all in the repo. Audit the code, fork it, own it.',
    icon: <path d="M8 9l-4 3 4 3M16 9l4 3-4 3M13 5l-2 14" />,
  },
] as const

export function SecuritySection() {
  return (
    <section className="section" id="security">
      <div className="home-container">
        <h2 className="section-title reveal">
          Your data <span className="title-serif">stays yours.</span>
        </h2>
        <p className="section-sub reveal">
          Local-first isn’t a setting — it’s the architecture. There is no Aila cloud holding your
          conversations.
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
          Start building <span className="title-serif">with Aila.</span>
        </h2>
        <p className="reveal">
          Open source, local-first, and free forever. Your agents are waiting.
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
