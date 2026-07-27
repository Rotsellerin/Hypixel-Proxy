export const BEDWARS_RESPAWN_MS = 5000
export const BEDWARS_RECONNECT_RESPAWN_MS = 10000

export type RespawnTimerEntry = {
  playerName: string
  playerKey: string
  expiresAt: number
  lastRenderedSeconds: number | null
}

export type RespawnTimerState = {
  timersByPlayerKey: Map<string, RespawnTimerEntry>
}

export type RespawnTimerUpdate = {
  playerName: string
  remainingSeconds: number | null
}

function normalizePlayerKey(playerName: string): string {
  return playerName.trim().toLowerCase()
}

export function createRespawnTimerState(): RespawnTimerState {
  return { timersByPlayerKey: new Map() }
}

export function startRespawnTimer(
  state: RespawnTimerState,
  playerName: string,
  now = Date.now(),
  durationMs = BEDWARS_RESPAWN_MS
) {
  const clean = playerName.trim()
  const key = normalizePlayerKey(clean)
  if (!key) return
  state.timersByPlayerKey.set(key, {
    playerName: clean,
    playerKey: key,
    expiresAt: now + durationMs,
    lastRenderedSeconds: null
  })
}

export function respawnTimerSeconds(
  state: RespawnTimerState,
  playerName: string,
  now = Date.now()
): number | null {
  const timer = state.timersByPlayerKey.get(normalizePlayerKey(playerName))
  if (!timer) return null
  const remaining = timer.expiresAt - now
  return remaining > 0 ? Math.ceil(remaining / 1000) : null
}

export function collectRespawnTimerUpdates(
  state: RespawnTimerState,
  now = Date.now()
): RespawnTimerUpdate[] {
  const updates: RespawnTimerUpdate[] = []

  for (const [key, timer] of state.timersByPlayerKey) {
    const remaining = timer.expiresAt - now
    const seconds = remaining > 0 ? Math.ceil(remaining / 1000) : null
    if (seconds !== timer.lastRenderedSeconds) {
      timer.lastRenderedSeconds = seconds
      updates.push({ playerName: timer.playerName, remainingSeconds: seconds })
    }
    if (seconds === null) state.timersByPlayerKey.delete(key)
  }

  return updates
}

export function clearRespawnTimers(state: RespawnTimerState): string[] {
  const playerNames = Array.from(state.timersByPlayerKey.values(), timer => timer.playerName)
  state.timersByPlayerKey.clear()
  return playerNames
}
