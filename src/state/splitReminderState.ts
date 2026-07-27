export type SplitReminderState = {
  respawning: boolean
  splitPending: boolean
  splitSignalId: number
  lastTrigger: string
  preRespawnTrigger: string
  preRespawnTriggerAt: number
  lastTeamSignature: string
  stableTeamColorName: string
  stableTeamPlayersByKey: Map<string, string>
  stableTeamMaxPlayers: number
  stableTeamMaxPlayersSource: string
  lastModeLogSignature: string
  bedWarsGameStartedAt: number
  bedWarsPregameSeenAt: number
  bedWarsScoreboardCountdownVisible: boolean
  bedWarsGameActive: boolean
}

export function createSplitReminderState(): SplitReminderState {
  return {
    respawning: false,
    splitPending: false,
    splitSignalId: 0,
    lastTrigger: '',
    preRespawnTrigger: '',
    preRespawnTriggerAt: 0,
    lastTeamSignature: '',
    stableTeamColorName: '',
    stableTeamPlayersByKey: new Map(),
    stableTeamMaxPlayers: 0,
    stableTeamMaxPlayersSource: '',
    lastModeLogSignature: '',
    bedWarsGameStartedAt: 0,
    bedWarsPregameSeenAt: 0,
    bedWarsScoreboardCountdownVisible: false,
    bedWarsGameActive: false
  }
}

export function resetSplitReminderMatchState(
  state: SplitReminderState,
  bedWarsGameActive = false,
  now = Date.now()
) {
  state.respawning = false
  state.splitPending = false
  state.splitSignalId = 0
  state.lastTrigger = ''
  state.preRespawnTrigger = ''
  state.preRespawnTriggerAt = 0
  state.lastTeamSignature = ''
  state.stableTeamColorName = ''
  state.stableTeamPlayersByKey.clear()
  state.stableTeamMaxPlayers = 0
  state.stableTeamMaxPlayersSource = ''
  state.bedWarsGameStartedAt = bedWarsGameActive ? now : 0
  state.bedWarsPregameSeenAt = 0
  state.bedWarsScoreboardCountdownVisible = false
  state.bedWarsGameActive = bedWarsGameActive
}
