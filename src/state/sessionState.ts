export type TeamState = {
  team: string
  packetName: string
  prefix: string
  suffix: string
  players: Set<string>
  sentPlayers: Set<string>
}

export type PlayerEntityState = {
  entityId: number
  uuid: string
  spawnPacket: any
  metadata: any[]
  equipment: Map<number, any>
}

export type SessionState = {
  playersByName: Map<string, any>
  knownPlayersByName: Map<string, any>
  knownTeamByPlayerKey: Map<string, TeamState>
  knownTeamsByPlayerKey: Map<string, Map<string, TeamState>>
  playerNameByUuid: Map<string, string>
  localPlayerUuid: string
  localGameMode: number | null
  localPlayerAliasesByKey: Map<string, string>
  teams: Map<string, TeamState>
  playerEntitiesByUuid: Map<string, PlayerEntityState>
  playerEntityUuidById: Map<number, string>
  scores: Map<string, any>
  displayedScoreboardObjectives: Map<number, string>
}

function stripColors(text: string): string {
  return text.replace(/\u00a7[0-9A-FK-ORa-fk-or]/g, '')
}

function validPlayerName(name: string): boolean {
  return /^[A-Za-z0-9_]{1,16}$/.test(name)
}

function playerKey(name: string): string {
  return stripColors(name).trim().toLowerCase()
}

function teamFormattingLength(team: TeamState): number {
  return stripColors(`${team.prefix || ''}${team.suffix || ''}`).trim().length
}

function isAction(action: unknown, text: string, id: number): boolean {
  return action === text || action === id
}

export function uuidKey(uuid: unknown): string {
  return String(uuid || '').replace(/-/g, '').toLowerCase()
}

export function clonePacketData(data: any): any {
  if (!data || typeof data !== 'object') return data
  return JSON.parse(JSON.stringify(data))
}

function mergeMetadata(existing: any[], incoming: any[]): any[] {
  if (!Array.isArray(incoming)) return existing
  const byKey = new Map<number, any>()
  for (const item of Array.isArray(existing) ? existing : []) {
    if (typeof item?.key === 'number') byKey.set(item.key, clonePacketData(item))
  }
  for (const item of incoming) {
    if (typeof item?.key === 'number') byKey.set(item.key, clonePacketData(item))
  }
  return Array.from(byKey.values()).sort((a, b) => a.key - b.key)
}

export function createSessionState(localPlayerName = '', localPlayerUuid = ''): SessionState {
  const aliases = new Map<string, string>()
  const cleanLocalPlayerName = stripColors(localPlayerName).trim()
  if (validPlayerName(cleanLocalPlayerName)) {
    aliases.set(playerKey(cleanLocalPlayerName), cleanLocalPlayerName)
  }

  return {
    playersByName: new Map(),
    knownPlayersByName: new Map(),
    knownTeamByPlayerKey: new Map(),
    knownTeamsByPlayerKey: new Map(),
    playerNameByUuid: new Map(),
    localPlayerUuid: uuidKey(localPlayerUuid),
    localGameMode: null,
    localPlayerAliasesByKey: aliases,
    teams: new Map(),
    playerEntitiesByUuid: new Map(),
    playerEntityUuidById: new Map(),
    scores: new Map(),
    displayedScoreboardObjectives: new Map()
  }
}

export function trackLocalGameMode(packet: any, state: SessionState) {
  const gameMode = Number(packet?.gameMode ?? packet?.gamemode)
  if (Number.isInteger(gameMode)) state.localGameMode = gameMode
}

export function trackPlayerInfo(packet: any, state: SessionState) {
  const players = Array.isArray(packet?.data) ? packet.data : []

  if (isAction(packet.action, 'add_player', 0)) {
    for (const player of players) {
      if (typeof player?.name !== 'string') continue
      const key = player.name.toLowerCase()
      const profile = clonePacketData(player)
      state.playersByName.set(key, profile)
      state.knownPlayersByName.set(key, profile)
      state.playerNameByUuid.set(uuidKey(player.uuid), key)
      if (state.localPlayerUuid && uuidKey(player.uuid) === state.localPlayerUuid) {
        state.localPlayerAliasesByKey.set(playerKey(player.name), player.name)
        const gameMode = Number(player.gamemode)
        if (Number.isInteger(gameMode)) state.localGameMode = gameMode
      }
    }
    return
  }

  if (isAction(packet.action, 'remove_player', 4)) {
    for (const player of players) {
      const key = state.playerNameByUuid.get(uuidKey(player?.uuid))
      if (!key) continue
      state.playersByName.delete(key)
    }
    return
  }

  for (const player of players) {
    const key = state.playerNameByUuid.get(uuidKey(player?.uuid))
    const cached = key ? state.knownPlayersByName.get(key) : null
    if (!cached) continue
    if ('gamemode' in player) cached.gamemode = player.gamemode
    if (
      state.localPlayerUuid
      && uuidKey(player?.uuid) === state.localPlayerUuid
      && Number.isInteger(Number(player?.gamemode))
    ) {
      state.localGameMode = Number(player.gamemode)
    }
    if ('ping' in player) cached.ping = player.ping
    if ('displayName' in player) cached.displayName = player.displayName
    if (key && state.playersByName.has(key)) state.playersByName.set(key, cached)
  }
}

export function teamPlayers(packet: any): string[] {
  if (Array.isArray(packet?.players)) return packet.players
  if (Array.isArray(packet?.entities)) return packet.entities
  return []
}

export function trackScoreboardTeam(
  packetName: string,
  packet: any,
  state: SessionState,
  _nicknames?: Map<string, string>
) {
  if (typeof packet?.team !== 'string') return

  const mode = Number(packet.mode)
  if (mode === 1) {
    state.teams.delete(packet.team)
    return
  }

  let team = state.teams.get(packet.team)
  if (!team) {
    team = {
      team: packet.team,
      packetName,
      prefix: '',
      suffix: '',
      players: new Set(),
      sentPlayers: new Set()
    }
    state.teams.set(packet.team, team)
  }
  team.packetName = packetName
  if (typeof packet.prefix === 'string') team.prefix = packet.prefix
  if (typeof packet.suffix === 'string') team.suffix = packet.suffix

  if (mode === 0) {
    team.players = new Set(teamPlayers(packet))
  } else if (mode === 3) {
    for (const player of teamPlayers(packet)) team.players.add(player)
  } else if (mode === 4) {
    for (const player of teamPlayers(packet)) team.players.delete(player)
  }

  team.sentPlayers = new Set(team.players)
  if (mode === 0 || mode === 3) {
    for (const playerName of teamPlayers(packet)) {
      const key = playerKey(playerName)
      let knownTeams = state.knownTeamsByPlayerKey.get(key)
      if (!knownTeams) {
        knownTeams = new Map()
        state.knownTeamsByPlayerKey.set(key, knownTeams)
      }
      knownTeams.set(team.team, team)
      const previous = state.knownTeamByPlayerKey.get(key)
      if (!previous || teamFormattingLength(team) >= teamFormattingLength(previous)) {
        state.knownTeamByPlayerKey.set(key, team)
      }
    }
  }
}

function playerEntityForId(entityId: unknown, state: SessionState): PlayerEntityState | null {
  if (typeof entityId !== 'number') return null
  const uuid = state.playerEntityUuidById.get(entityId)
  return uuid ? state.playerEntitiesByUuid.get(uuid) || null : null
}

export function trackNamedEntitySpawn(packet: any, state: SessionState) {
  if (typeof packet?.entityId !== 'number') return
  const uuid = uuidKey(packet.playerUUID)
  const entity: PlayerEntityState = {
    entityId: packet.entityId,
    uuid,
    spawnPacket: clonePacketData(packet),
    metadata: Array.isArray(packet.metadata) ? clonePacketData(packet.metadata) : [],
    equipment: new Map()
  }
  state.playerEntitiesByUuid.set(uuid, entity)
  state.playerEntityUuidById.set(packet.entityId, uuid)
}

export function trackEntityMovement(packetName: string, packet: any, state: SessionState) {
  const entity = playerEntityForId(packet?.entityId, state)
  if (!entity) return

  if (packetName === 'entity_teleport') {
    for (const field of ['x', 'y', 'z', 'yaw', 'pitch']) {
      if (typeof packet[field] === 'number') entity.spawnPacket[field] = packet[field]
    }
    return
  }

  if (packetName === 'rel_entity_move' || packetName === 'entity_move_look') {
    entity.spawnPacket.x += Number(packet.dX || 0)
    entity.spawnPacket.y += Number(packet.dY || 0)
    entity.spawnPacket.z += Number(packet.dZ || 0)
  }

  if (packetName === 'entity_look' || packetName === 'entity_move_look') {
    if (typeof packet.yaw === 'number') entity.spawnPacket.yaw = packet.yaw
    if (typeof packet.pitch === 'number') entity.spawnPacket.pitch = packet.pitch
  }
}

export function trackEntityMetadata(packet: any, state: SessionState) {
  const entity = playerEntityForId(packet?.entityId, state)
  if (!entity) return
  entity.metadata = mergeMetadata(entity.metadata, packet.metadata)
  entity.spawnPacket.metadata = entity.metadata
}

export function trackEntityEquipment(packet: any, state: SessionState) {
  const entity = playerEntityForId(packet?.entityId, state)
  if (!entity || typeof packet.slot !== 'number') return
  entity.equipment.set(packet.slot, clonePacketData(packet))
}

export function trackEntityDestroy(packet: any, state: SessionState) {
  if (!Array.isArray(packet?.entityIds)) return
  for (const entityId of packet.entityIds) {
    const uuid = state.playerEntityUuidById.get(entityId)
    if (!uuid) continue
    state.playerEntityUuidById.delete(entityId)
    state.playerEntitiesByUuid.delete(uuid)
  }
}

export function scoreKey(itemName: unknown, scoreName: unknown): string {
  return `${String(scoreName)}\u0000${String(itemName).toLowerCase()}`
}

export function trackScoreboardObjective(packet: any, state: SessionState) {
  if (typeof packet?.name !== 'string' || Number(packet.action) !== 1) return
  for (const [position, objectiveName] of state.displayedScoreboardObjectives) {
    if (objectiveName === packet.name) state.displayedScoreboardObjectives.delete(position)
  }
  for (const [key, score] of state.scores) {
    if (score?.scoreName === packet.name) state.scores.delete(key)
  }
}

export function trackScoreboardDisplayObjective(packet: any, state: SessionState) {
  const position = Number(packet?.position)
  if (!Number.isInteger(position)) return
  const previousObjective = state.displayedScoreboardObjectives.get(position)
  const nextObjective = typeof packet?.name === 'string' && packet.name ? packet.name : ''
  if (previousObjective && previousObjective !== nextObjective) {
    for (const [key, score] of state.scores) {
      if (score?.scoreName === previousObjective) state.scores.delete(key)
    }
  }
  if (typeof packet?.name !== 'string' || !packet.name) {
    state.displayedScoreboardObjectives.delete(position)
    return
  }
  state.displayedScoreboardObjectives.set(position, packet.name)
}

export function trackScoreboardScore(packet: any, state: SessionState) {
  if (typeof packet?.itemName !== 'string' || typeof packet?.scoreName !== 'string') return
  const key = scoreKey(packet.itemName, packet.scoreName)
  if (Number(packet.action) === 1) {
    state.scores.delete(key)
    return
  }

  state.scores.set(key, clonePacketData(packet))
}
