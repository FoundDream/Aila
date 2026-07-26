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
