export interface TurnStartLock {
  promise: Promise<void>
  release: () => void
  released: boolean
}

export interface CoordinatedTurn {
  controller: AbortController
  turnStartLock: TurnStartLock
}

/**
 * Owns per-session turn serialization and the active-turn registry.
 * Preparing context and executing a run remain separate services.
 */
export class TurnCoordinator<TTurn extends CoordinatedTurn> {
  private readonly activeTurns = new Map<string, TTurn>()
  private readonly startLocks = new Map<string, TurnStartLock>()

  async withStartLock<T>(
    sessionId: string,
    operation: (lock: TurnStartLock) => Promise<T>,
  ): Promise<T> {
    const previous = this.startLocks.get(sessionId)
    let resolveLock: () => void = () => {}
    const promise = new Promise<void>((resolve) => {
      resolveLock = resolve
    })
    const current: TurnStartLock = {
      promise,
      released: false,
      release: () => {},
    }
    current.release = () => {
      if (current.released) return
      current.released = true
      resolveLock()
    }
    this.startLocks.set(sessionId, current)

    if (previous) await previous.promise
    try {
      return await operation(current)
    } finally {
      this.release(current)
      if (this.startLocks.get(sessionId) === current) {
        this.startLocks.delete(sessionId)
      }
    }
  }

  get(sessionId: string): TTurn | undefined {
    return this.activeTurns.get(sessionId)
  }

  has(sessionId: string): boolean {
    return this.activeTurns.has(sessionId)
  }

  set(sessionId: string, turn: TTurn): void {
    this.activeTurns.set(sessionId, turn)
  }

  delete(sessionId: string, expected?: TTurn): boolean {
    if (expected && this.activeTurns.get(sessionId) !== expected) return false
    return this.activeTurns.delete(sessionId)
  }

  deleteWhere(sessionId: string, predicate: (turn: TTurn) => boolean): boolean {
    const current = this.activeTurns.get(sessionId)
    if (!current || !predicate(current)) return false
    return this.activeTurns.delete(sessionId)
  }

  entries(): Array<[string, TTurn]> {
    return Array.from(this.activeTurns.entries())
  }

  clearTimedOut(sessionId: string, turn: TTurn): void {
    this.delete(sessionId, turn)
    this.release(turn.turnStartLock)
    if (this.startLocks.get(sessionId) === turn.turnStartLock) {
      this.startLocks.delete(sessionId)
    }
  }

  private release(lock: TurnStartLock): void {
    lock.release()
  }
}

/**
 * Single-session variant used by SessionRuntime. It preserves the coordinator
 * contract while storing one active turn and one start lock as scalar state.
 */
export class SessionTurnCoordinator<TTurn extends CoordinatedTurn> {
  private activeTurn: TTurn | undefined
  private startLock: TurnStartLock | undefined

  constructor(private readonly sessionId: string) {}

  async withStartLock<T>(
    sessionId: string,
    operation: (lock: TurnStartLock) => Promise<T>,
  ): Promise<T> {
    this.assertSession(sessionId)
    const previous = this.startLock
    let resolveLock: () => void = () => {}
    const promise = new Promise<void>((resolve) => {
      resolveLock = resolve
    })
    const current: TurnStartLock = {
      promise,
      released: false,
      release: () => {},
    }
    current.release = () => {
      if (current.released) return
      current.released = true
      resolveLock()
    }
    this.startLock = current

    if (previous) await previous.promise
    try {
      return await operation(current)
    } finally {
      current.release()
      if (this.startLock === current) this.startLock = undefined
    }
  }

  get(sessionId: string): TTurn | undefined {
    this.assertSession(sessionId)
    return this.activeTurn
  }

  has(sessionId: string): boolean {
    this.assertSession(sessionId)
    return this.activeTurn !== undefined
  }

  set(sessionId: string, turn: TTurn): void {
    this.assertSession(sessionId)
    this.activeTurn = turn
  }

  delete(sessionId: string, expected?: TTurn): boolean {
    this.assertSession(sessionId)
    if (!this.activeTurn || (expected && this.activeTurn !== expected)) return false
    this.activeTurn = undefined
    return true
  }

  deleteWhere(sessionId: string, predicate: (turn: TTurn) => boolean): boolean {
    this.assertSession(sessionId)
    if (!this.activeTurn || !predicate(this.activeTurn)) return false
    this.activeTurn = undefined
    return true
  }

  entries(): Array<[string, TTurn]> {
    return this.activeTurn ? [[this.sessionId, this.activeTurn]] : []
  }

  clearTimedOut(sessionId: string, turn: TTurn): void {
    this.assertSession(sessionId)
    this.delete(sessionId, turn)
    turn.turnStartLock.release()
    if (this.startLock === turn.turnStartLock) this.startLock = undefined
  }

  private assertSession(sessionId: string): void {
    if (sessionId !== this.sessionId) {
      throw new Error(`session runtime is bound to ${this.sessionId}, received ${sessionId}`)
    }
  }
}
