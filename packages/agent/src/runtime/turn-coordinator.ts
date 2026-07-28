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
 * Owns turn serialization and the active-turn slot for exactly one session.
 * Preparing context and executing a run remain separate services.
 */
export class SessionTurnCoordinator<TTurn extends CoordinatedTurn> {
  private activeTurn: TTurn | undefined
  private startLock: TurnStartLock | undefined

  constructor(private readonly sessionId: string) {}

  async withStartLock<T>(operation: (lock: TurnStartLock) => Promise<T>): Promise<T> {
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

  get(): TTurn | undefined {
    return this.activeTurn
  }

  has(): boolean {
    return this.activeTurn !== undefined
  }

  set(turn: TTurn): void {
    this.activeTurn = turn
  }

  delete(expected?: TTurn): boolean {
    if (!this.activeTurn || (expected && this.activeTurn !== expected)) return false
    this.activeTurn = undefined
    return true
  }

  deleteWhere(predicate: (turn: TTurn) => boolean): boolean {
    if (!this.activeTurn || !predicate(this.activeTurn)) return false
    this.activeTurn = undefined
    return true
  }

  entries(): Array<[string, TTurn]> {
    return this.activeTurn ? [[this.sessionId, this.activeTurn]] : []
  }

  clearTimedOut(turn: TTurn): void {
    this.delete(turn)
    turn.turnStartLock.release()
    if (this.startLock === turn.turnStartLock) this.startLock = undefined
  }
}
