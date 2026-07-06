import mc, { Client, Server, ServerClient, ServerOptions } from 'minecraft-protocol'
import fs from 'fs'
import path from 'path'
import { MsaCode, microsoftAuthPrompt } from './microsoftAuthPrompt'

type NicknameFile = { nicknames: Record<string, string> }
type SessionState = {
  playersByName: Map<string, any>
  playerNameByUuid: Map<string, string>
  teams: Map<string, TeamState>
  playerEntitiesByUuid: Map<string, PlayerEntityState>
  playerEntityUuidById: Map<number, string>
  scores: Map<string, any>
}
type TeamState = {
  team: string
  packetName: string
  prefix: string
  suffix: string
  players: Set<string>
  sentPlayers: Set<string>
}
type PlayerEntityState = {
  entityId: number
  uuid: string
  spawnPacket: any
  metadata: any[]
  equipment: Map<number, any>
}

loadDotEnv(path.join(process.cwd(), '.env'))

const VERSION = (process.env.MC_VERSION || '1.8.8') as any
const LISTEN_HOST = process.env.LISTEN_HOST || '127.0.0.1'
const LISTEN_PORT = Number(process.env.LISTEN_PORT || 25565)
const UP_HOST = process.env.HYPIXEL_HOST || 'mc.hypixel.net'
const UP_PORT = Number(process.env.HYPIXEL_PORT || 25565)
const STATE_DIR = process.env.STATE_DIR || path.join(process.cwd(), 'state')
const NICKNAME_PATH = path.join(STATE_DIR, 'nicknames.json')
const AUTH_CACHE_DIR = path.join(STATE_DIR, 'auth-cache')
const LOCAL_ADDRESS = LISTEN_PORT === 25565 ? 'localhost' : `localhost:${LISTEN_PORT}`
const VERSION_LABEL = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).version || '1.0.0'
  } catch {
    return '1.0.0'
  }
})()

const colors = {
  reset: '\x1b[0m',
  gray: '\x1b[90m',
  red: '\x1b[91m',
  green: '\x1b[92m',
  yellow: '\x1b[93m',
  cyan: '\x1b[96m',
  magenta: '\x1b[95m',
  white: '\x1b[97m'
}

function loadDotEnv(filePath: string) {
  if (!fs.existsSync(filePath)) return

  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed)
    if (!match || process.env[match[1]] != null) continue
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '')
  }
}

function color(text: string, ansi: string): string {
  return ansi + text + colors.reset
}

function term(label: string, message: string, labelColor = colors.white) {
  console.log(`${color(label, labelColor)} ${colors.gray}>${colors.reset} ${message}`)
}

function printLauncherHeader() {
  console.log('Hypixel Proxy')
  console.log('=========================')
  term('Proxy', `v${VERSION_LABEL}`, colors.red)
  term('Config', `Loaded local config from ${path.relative(process.cwd(), STATE_DIR) || STATE_DIR}.`, colors.yellow)
  term('Ready', 'Join Hypixel using the address below:', colors.green)
  console.log('')
  console.log(' Server Address')
  console.log('+------------------------------+')
  console.log(`| ${LOCAL_ADDRESS.padEnd(28, ' ')} |`)
  console.log('+------------------------------+')
  console.log('')
  term('Upstream', `${UP_HOST}:${UP_PORT}`, colors.cyan)
  console.log('')
}

function logSessionClosed(why: string) {
  term('Local', `Session closed: ${why}`, colors.magenta)
}

function stripColors(text: string): string {
  return text.replace(/§[0-9A-FK-ORa-fk-or]/g, '')
}

function validPlayerName(name: string): boolean {
  return /^[A-Za-z0-9_]{1,16}$/.test(name)
}

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true })
  fs.mkdirSync(AUTH_CACHE_DIR, { recursive: true })
}

function loadNicknames(): Map<string, string> {
  ensureStateDir()
  if (!fs.existsSync(NICKNAME_PATH)) {
    fs.writeFileSync(NICKNAME_PATH, JSON.stringify({ nicknames: {} }, null, 2))
    return new Map()
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(NICKNAME_PATH, 'utf8')) as NicknameFile
    const map = new Map<string, string>()
    for (const [player, nickname] of Object.entries(parsed.nicknames || {})) {
      if (validPlayerName(player) && typeof nickname === 'string' && nickname.trim()) {
        map.set(player.toLowerCase(), nickname.trim())
      }
    }
    return map
  } catch (error) {
    term('Config', `Could not read nicknames.json, recreating it: ${String(error)}`, colors.yellow)
    fs.writeFileSync(NICKNAME_PATH, JSON.stringify({ nicknames: {} }, null, 2))
    return new Map()
  }
}

function saveNicknames(nicknames: Map<string, string>) {
  ensureStateDir()
  const out: NicknameFile = { nicknames: {} }
  for (const [player, nickname] of Array.from(nicknames.entries()).sort()) {
    out.nicknames[player] = nickname
  }

  const tmp = NICKNAME_PATH + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2))
  fs.renameSync(tmp, NICKNAME_PATH)
}

function flattenChatToText(comp: any): string {
  if (comp == null) return ''
  if (typeof comp === 'string') {
    try {
      return flattenChatToText(JSON.parse(comp))
    } catch {
      return comp
    }
  }
  if (typeof comp === 'number' || typeof comp === 'boolean') return String(comp)

  let out = ''
  if (typeof comp.text === 'string') out += comp.text
  if (Array.isArray(comp.extra)) {
    for (const extra of comp.extra) out += flattenChatToText(extra)
  }
  if (comp.translate) {
    if (Array.isArray(comp.with)) out += comp.with.map(flattenChatToText).join('')
    else out += String(comp.translate)
  }
  return out
}

function replaceNames(text: string, nicknames: Map<string, string>): string {
  let out = text
  for (const [player, nickname] of nicknames.entries()) {
    out = out.replace(new RegExp(`\\b${escapeRegExp(player)}\\b`, 'gi'), nickname)
  }
  return out
}

function replaceNamesInChat(comp: any, nicknames: Map<string, string>): any {
  if (typeof comp === 'string') return replaceNames(comp, nicknames)
  if (Array.isArray(comp)) return comp.map(item => replaceNamesInChat(item, nicknames))
  if (!comp || typeof comp !== 'object') return comp

  const copy: any = { ...comp }
  if (typeof copy.text === 'string') copy.text = replaceNames(copy.text, nicknames)
  if (Array.isArray(copy.extra)) copy.extra = copy.extra.map((item: any) => replaceNamesInChat(item, nicknames))
  if (Array.isArray(copy.with)) copy.with = copy.with.map((item: any) => replaceNamesInChat(item, nicknames))
  return copy
}

function replaceNamesInChatString(text: unknown, nicknames: Map<string, string>): unknown {
  if (typeof text !== 'string') return text
  try {
    return JSON.stringify(replaceNamesInChat(JSON.parse(text), nicknames))
  } catch {
    return replaceNames(text, nicknames)
  }
}

function nicknameForPlayer(name: unknown, nicknames: Map<string, string>): string | null {
  if (typeof name !== 'string') return null
  return nicknames.get(stripColors(name).toLowerCase()) || null
}

function nicknameForProfileName(name: unknown, nicknames: Map<string, string>): string | null {
  const nickname = nicknameForPlayer(name, nicknames)
  if (!nickname) return null
  const clean = stripColors(nickname).trim()
  return validPlayerName(clean) ? clean : null
}

function localProfileName(name: string, nicknames: Map<string, string>): string {
  return nicknameForProfileName(name, nicknames) || name
}

function isAction(action: unknown, text: string, id: number): boolean {
  return action === text || action === id
}

function withNicknamePlayerInfo(packet: any, nicknames: Map<string, string>): any {
  const players = Array.isArray(packet?.data) ? packet.data : null
  if (!players) return packet

  const addPlayer = isAction(packet.action, 'add_player', 0)
  const updatesDisplayName = addPlayer || isAction(packet.action, 'update_display_name', 3)
  let changed = false
  const nextPlayers = players.map((player: any) => {
    let next = player
    if (addPlayer && typeof player?.name === 'string') {
      const localName = nicknameForProfileName(player.name, nicknames)
      if (localName && localName !== player.name) {
        next = { ...next, name: localName }
        changed = true
      }
    }

    if (updatesDisplayName && typeof player?.displayName === 'string') {
      const displayName = replaceNamesInChatString(player.displayName, nicknames)
      if (displayName !== player.displayName) {
        next = next === player ? { ...next } : next
        next.displayName = displayName
        changed = true
      }
    }

    return next
  })

  if (!changed) return packet
  return { ...packet, data: nextPlayers }
}

function withNicknameScoreboardTeam(packet: any, nicknames: Map<string, string>): any {
  let changed = false
  const next: any = { ...packet }

  if (Array.isArray(packet.players)) {
    next.players = packet.players.map((player: string) => {
      const localName = localProfileName(player, nicknames)
      if (localName !== player) changed = true
      return localName
    })
  }

  if (Array.isArray(packet.entities)) {
    next.entities = packet.entities.map((entity: string) => {
      const localName = localProfileName(entity, nicknames)
      if (localName !== entity) changed = true
      return localName
    })
  }

  return changed ? next : packet
}

function withNicknameScoreboardScore(packet: any, nicknames: Map<string, string>): any {
  if (typeof packet?.itemName !== 'string') return packet

  const itemName = localProfileName(packet.itemName, nicknames)
  if (itemName === packet.itemName) return packet
  return { ...packet, itemName }
}

function withNicknameMetadata(metadata: any, nicknames: Map<string, string>): any {
  if (!Array.isArray(metadata)) return metadata

  let changed = false
  const next = metadata.map((item: any) => {
    if (!item || typeof item !== 'object') return item
    if (typeof item.value !== 'string') return item

    const value = replaceNames(item.value, nicknames)
    if (value === item.value) return item
    changed = true
    return { ...item, value }
  })

  return changed ? next : metadata
}

function withNicknameEntityMetadata(packet: any, nicknames: Map<string, string>): any {
  const metadata = withNicknameMetadata(packet?.metadata, nicknames)
  return metadata === packet?.metadata ? packet : { ...packet, metadata }
}

function withNicknameNamedEntitySpawn(packet: any, nicknames: Map<string, string>): any {
  return withNicknameEntityMetadata(packet, nicknames)
}

function createSessionState(): SessionState {
  return {
    playersByName: new Map(),
    playerNameByUuid: new Map(),
    teams: new Map(),
    playerEntitiesByUuid: new Map(),
    playerEntityUuidById: new Map(),
    scores: new Map()
  }
}

function uuidKey(uuid: unknown): string {
  return String(uuid)
}

function clonePacketData(data: any): any {
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

function trackPlayerInfo(packet: any, state: SessionState) {
  const players = Array.isArray(packet?.data) ? packet.data : []

  if (isAction(packet.action, 'add_player', 0)) {
    for (const player of players) {
      if (typeof player?.name !== 'string') continue
      const key = player.name.toLowerCase()
      state.playersByName.set(key, clonePacketData(player))
      state.playerNameByUuid.set(uuidKey(player.uuid), key)
    }
    return
  }

  if (isAction(packet.action, 'remove_player', 4)) {
    for (const player of players) {
      const key = state.playerNameByUuid.get(uuidKey(player?.uuid))
      if (!key) continue
      state.playerNameByUuid.delete(uuidKey(player.uuid))
      state.playersByName.delete(key)
    }
    return
  }

  for (const player of players) {
    const key = state.playerNameByUuid.get(uuidKey(player?.uuid))
    const cached = key ? state.playersByName.get(key) : null
    if (!cached) continue
    if ('gamemode' in player) cached.gamemode = player.gamemode
    if ('ping' in player) cached.ping = player.ping
    if ('displayName' in player) cached.displayName = player.displayName
  }
}

function teamPlayers(packet: any): string[] {
  if (Array.isArray(packet?.players)) return packet.players
  if (Array.isArray(packet?.entities)) return packet.entities
  return []
}

function rewrittenTeamPlayers(players: Set<string>, nicknames: Map<string, string>): Set<string> {
  return new Set(Array.from(players, player => localProfileName(player, nicknames)))
}

function trackScoreboardTeam(packetName: string, packet: any, state: SessionState, nicknames: Map<string, string>) {
  if (typeof packet?.team !== 'string') return

  const mode = Number(packet.mode)
  if (mode === 1) {
    state.teams.delete(packet.team)
    return
  }

  let team = state.teams.get(packet.team)
  if (!team) {
    team = { team: packet.team, packetName, prefix: '', suffix: '', players: new Set(), sentPlayers: new Set() }
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

  team.sentPlayers = rewrittenTeamPlayers(team.players, nicknames)
}

function trackNamedEntitySpawn(packet: any, state: SessionState) {
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

function playerEntityForId(entityId: unknown, state: SessionState): PlayerEntityState | null {
  if (typeof entityId !== 'number') return null
  const uuid = state.playerEntityUuidById.get(entityId)
  return uuid ? state.playerEntitiesByUuid.get(uuid) || null : null
}

function trackEntityMovement(packetName: string, packet: any, state: SessionState) {
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

function trackEntityMetadata(packet: any, state: SessionState) {
  const entity = playerEntityForId(packet?.entityId, state)
  if (!entity) return
  entity.metadata = mergeMetadata(entity.metadata, packet.metadata)
  entity.spawnPacket.metadata = entity.metadata
}

function trackEntityEquipment(packet: any, state: SessionState) {
  const entity = playerEntityForId(packet?.entityId, state)
  if (!entity || typeof packet.slot !== 'number') return
  entity.equipment.set(packet.slot, clonePacketData(packet))
}

function trackEntityDestroy(packet: any, state: SessionState) {
  if (!Array.isArray(packet?.entityIds)) return
  for (const entityId of packet.entityIds) {
    const uuid = state.playerEntityUuidById.get(entityId)
    if (!uuid) continue
    state.playerEntityUuidById.delete(entityId)
    state.playerEntitiesByUuid.delete(uuid)
  }
}

function scoreKey(itemName: unknown, scoreName: unknown): string {
  return `${String(scoreName)}\u0000${String(itemName).toLowerCase()}`
}

function trackScoreboardScore(packet: any, state: SessionState) {
  if (typeof packet?.itemName !== 'string' || typeof packet?.scoreName !== 'string') return
  const key = scoreKey(packet.itemName, packet.scoreName)
  if (Number(packet.action) === 1) {
    state.scores.delete(key)
    return
  }

  state.scores.set(key, clonePacketData(packet))
}

function sendTeamPlayerDiff(downstream: ServerClient, team: TeamState, nextPlayers: Set<string>) {
  const toRemove = Array.from(team.sentPlayers).filter(player => !nextPlayers.has(player))
  const toAdd = Array.from(nextPlayers).filter(player => !team.sentPlayers.has(player))

  if (toRemove.length) {
    downstream.write(team.packetName, { team: team.team, mode: 4, players: toRemove })
  }
  if (toAdd.length) {
    downstream.write(team.packetName, { team: team.team, mode: 3, players: toAdd })
  }

  team.sentPlayers = nextPlayers
}

function refreshLocalNicknames(downstream: ServerClient, state: SessionState, nicknames: Map<string, string>) {
  for (const player of state.playersByName.values()) {
    try {
      downstream.write('player_info', {
        action: 'remove_player',
        data: [{ uuid: player.uuid }]
      })
      downstream.write('player_info', withNicknamePlayerInfo({
        action: 'add_player',
        data: [player]
      }, nicknames))
    } catch {}
  }

  for (const team of state.teams.values()) {
    try {
      sendTeamPlayerDiff(downstream, team, rewrittenTeamPlayers(team.players, nicknames))
    } catch {}
  }

  for (const score of state.scores.values()) {
    try {
      const rewritten = withNicknameScoreboardScore(score, nicknames)
      if (rewritten !== score) {
        downstream.write('scoreboard_score', rewritten)
      }
    } catch {}
  }

  for (const entity of state.playerEntitiesByUuid.values()) {
    try {
      downstream.write('entity_destroy', { entityIds: [entity.entityId] })
      downstream.write('named_entity_spawn', withNicknameNamedEntitySpawn({
        ...entity.spawnPacket,
        metadata: entity.metadata
      }, nicknames))
      for (const equipment of Array.from(entity.equipment.values()).sort((a, b) => a.slot - b.slot)) {
        downstream.write('entity_equipment', equipment)
      }
    } catch {}
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function infoChat(text: string): any {
  return { text: '[Nick] ' + text, color: 'yellow' }
}

function okChat(text: string): any {
  return { text: '[Nick] ' + text, color: 'green' }
}

function errChat(text: string): any {
  return { text: '[Nick] ' + text, color: 'red' }
}

function isExpectedDisconnectError(error: unknown): boolean {
  const code = typeof error === 'object' && error && 'code' in error ? String((error as any).code) : ''
  return code === 'ECONNRESET' || code === 'ECONNABORTED'
}

function endClient(client: Client, reason: string) {
  try {
    client.end(reason)
  } catch {}
}

function sendClientChat(client: ServerClient, comp: any, position = 0) {
  try {
    client.write('chat', { message: JSON.stringify(comp), position })
  } catch {}
}

function showMicrosoftCode(player: string, downstream: ServerClient, data: MsaCode) {
  const prompt = microsoftAuthPrompt(player, data)

  console.log('')
  term('Microsoft', `Please go to ${color(prompt.url, colors.cyan)} and enter the code ${color(prompt.code, colors.yellow)}.`, colors.cyan)
  console.log(`Then sign into the Microsoft account you use for ${color(player, colors.cyan)}.`)
  console.log('')

  sendClientChat(downstream, prompt.chatIntro)
  sendClientChat(downstream, prompt.chatLink)
  sendClientChat(downstream, prompt.chatAccount)
}

function parseNicknameCommand(message: string): { player: string; nickname: string } | null {
  const match = /^\s*\/nickname\s+([A-Za-z0-9_]{1,16})\s+(.+?)\s*$/.exec(message)
  if (!match) return null

  let nickname = match[2].trim()
  const quoted = /^"([^"]+)"$/.exec(nickname)
  if (quoted) nickname = quoted[1].trim()

  return { player: match[1], nickname }
}

function bridgeLogin(upstream: Client, downstream: ServerClient) {
  upstream.on('packet', (data, meta) => {
    if (upstream.state !== 'login' || downstream.state !== 'login') return
    try {
      downstream.write(meta.name, data)
    } catch {}
  })

  downstream.on('packet', (data, meta) => {
    if (downstream.state !== 'login' || upstream.state !== 'login') return
    try {
      upstream.write(meta.name, data)
    } catch {}
  })
}

function bridgePlay(upstream: Client, downstream: ServerClient, nicknames: Map<string, string>, sessionState: SessionState) {
  upstream.on('packet', (data, meta) => {
    if (upstream.state !== 'play' || downstream.state !== 'play') return

    try {
      if (meta.name === 'chat') {
        const raw = (data as any).message
        const comp = (() => {
          try {
            return JSON.parse(raw)
          } catch {
            return raw
          }
        })()
        downstream.write('chat', {
          ...data,
          message: JSON.stringify(replaceNamesInChat(comp, nicknames)),
          position: (data as any).position ?? 0
        })
        return
      }

      if (meta.name === 'player_info') {
        trackPlayerInfo(data, sessionState)
        downstream.write(meta.name, withNicknamePlayerInfo(data, nicknames))
        return
      }

      if (meta.name === 'scoreboard_team' || meta.name === 'teams') {
        trackScoreboardTeam(meta.name, data, sessionState, nicknames)
        downstream.write(meta.name, withNicknameScoreboardTeam(data, nicknames))
        return
      }

      if (meta.name === 'scoreboard_score') {
        trackScoreboardScore(data, sessionState)
        downstream.write(meta.name, withNicknameScoreboardScore(data, nicknames))
        return
      }

      if (meta.name === 'named_entity_spawn') {
        trackNamedEntitySpawn(data, sessionState)
        downstream.write(meta.name, withNicknameNamedEntitySpawn(data, nicknames))
        return
      }

      if (meta.name === 'entity_metadata') {
        trackEntityMetadata(data, sessionState)
        downstream.write(meta.name, withNicknameEntityMetadata(data, nicknames))
        return
      }

      if (meta.name === 'entity_equipment') {
        trackEntityEquipment(data, sessionState)
        downstream.write(meta.name, data)
        return
      }

      if (meta.name === 'entity_destroy') {
        trackEntityDestroy(data, sessionState)
        downstream.write(meta.name, data)
        return
      }

      if (meta.name === 'rel_entity_move' || meta.name === 'entity_move_look' || meta.name === 'entity_look' || meta.name === 'entity_teleport') {
        trackEntityMovement(meta.name, data, sessionState)
        downstream.write(meta.name, data)
        return
      }

      downstream.write(meta.name, data)
    } catch {}
  })

  downstream.on('packet', (data, meta) => {
    if (downstream.state !== 'play' || upstream.state !== 'play') return

    if (meta.name === 'chat') {
      const message = String((data as any).message || '')

      if (/^\s*\/nicknames\b/i.test(message)) {
        const rows = Array.from(nicknames.entries()).sort()
        if (!rows.length) {
          sendClientChat(downstream, infoChat('Inga nicknames sparade.'))
          return
        }
        sendClientChat(downstream, infoChat(rows.map(([player, nickname]) => `${player} = ${nickname}`).join(', ')))
        return
      }

      const clearMatch = /^\s*\/nickname\s+([A-Za-z0-9_]{1,16})\s+(?:clear|remove|delete)\s*$/i.exec(message)
      if (clearMatch) {
        const key = clearMatch[1].toLowerCase()
        if (nicknames.delete(key)) {
          saveNicknames(nicknames)
          refreshLocalNicknames(downstream, sessionState, nicknames)
          sendClientChat(downstream, okChat(`Tog bort nickname for ${clearMatch[1]}.`))
        } else {
          sendClientChat(downstream, infoChat(`${clearMatch[1]} hade ingen nickname.`))
        }
        return
      }

      const nickname = parseNicknameCommand(message)
      if (nickname) {
        if (!nickname.nickname || nickname.nickname.length > 32) {
          sendClientChat(downstream, errChat('Usage: /nickname <player> "nickname" (max 32 tecken)'))
          return
        }

        nicknames.set(nickname.player.toLowerCase(), stripColors(nickname.nickname))
        saveNicknames(nicknames)
        refreshLocalNicknames(downstream, sessionState, nicknames)
        sendClientChat(downstream, okChat(`${nickname.player} visas som ${nickname.nickname}.`))
        if (!nicknameForProfileName(nickname.player, nicknames)) {
          sendClientChat(downstream, infoChat('Nametag-byte kraver ett nickname med 1-16 tecken: A-Z, 0-9 eller _.'))
        }
        return
      }

      if (/^\s*\/nickname\b/i.test(message)) {
        sendClientChat(downstream, infoChat('Usage: /nickname <player> "nickname"'))
        return
      }
    }

    try {
      upstream.write(meta.name, data)
    } catch {}
  })
}

export const __test = {
  createSessionState,
  refreshLocalNicknames,
  trackNamedEntitySpawn,
  trackPlayerInfo,
  trackScoreboardTeam,
  trackScoreboardScore,
  withNicknameEntityMetadata,
  withNicknameNamedEntitySpawn,
  withNicknamePlayerInfo,
  withNicknameScoreboardScore,
  withNicknameScoreboardTeam
}

export function startProxy(): Server {
  const serverOpts: ServerOptions = {
    host: LISTEN_HOST,
    port: LISTEN_PORT,
    version: VERSION,
    keepAlive: true,
    'online-mode': true,
    hideErrors: true,
    errorHandler: (client, error) => {
      if (!isExpectedDisconnectError(error)) {
        console.error('[hypixel-proxy] client error:', error)
      }
      endClient(client, 'Client disconnected')
    }
  }
  const server: Server = mc.createServer(serverOpts)

  server.on('error', error => {
    console.error('[hypixel-proxy] server error:', error)
  })

  printLauncherHeader()

  server.on('connection', (client: ServerClient) => {
    client.on('packet', async (data, meta) => {
      if (client.state !== 'status') return

      if (meta.name === 'ping_start') {
        try {
          const pong: any = await mc.ping({ host: UP_HOST, port: UP_PORT, version: VERSION } as any)
          client.write('status_response', {
            response: JSON.stringify({
              version: pong.version ?? { name: VERSION, protocol: (client as any).protocolVersion ?? 47 },
              players: pong.players ?? { max: 200, online: 0, sample: [] },
              description: typeof pong.description === 'object' ? pong.description : { text: String(pong.description || 'Hypixel') }
            })
          })
        } catch {
          client.write('status_response', {
            response: JSON.stringify({
              version: { name: VERSION, protocol: (client as any).protocolVersion ?? 47 },
              players: { max: 0, online: 0, sample: [] },
              description: { text: 'Hypixel' }
            })
          })
        }
      }

      if (meta.name === 'ping') client.write('pong', { time: (data as any).time })
    })
  })

  server.on('login', (downstream: ServerClient) => {
    const clientSocket = (downstream as any).socket
    const remoteHost = clientSocket?.remoteAddress || 'localhost'
    const remotePort = clientSocket?.remotePort || LISTEN_PORT
    term('Local', `${downstream.username} is logging in from ${remoteHost}:${remotePort} using Hypixel Proxy`, colors.magenta)

    const nicknames = loadNicknames()
    const sessionState = createSessionState()
    let microsoftCodeShown = false
    const upstream: Client = mc.createClient({
      host: UP_HOST,
      port: UP_PORT,
      version: VERSION,
      auth: 'microsoft',
      username: downstream.username,
      profilesFolder: AUTH_CACHE_DIR,
      onMsaCode: (data: MsaCode) => {
        microsoftCodeShown = true
        showMicrosoftCode(downstream.username, downstream, data)
        term('Microsoft', `Finish this sign-in first. If Minecraft disconnects, reconnect to ${LOCAL_ADDRESS} after the sign-in completes.`, colors.yellow)
      },
      keepAlive: true,
      hideErrors: true
    } as any)

    let localClosed = false
    let downstreamEnded = false
    let upstreamConnected = false
    let upstreamSessionReady = false
    let detachedAuth = false

    const keepMicrosoftAuthRunning = (why: string) => {
      if (localClosed) return
      localClosed = true
      detachedAuth = true
      logSessionClosed(`${why}; Microsoft sign-in is still running`)
      term('Microsoft', `Complete the browser sign-in, wait for confirmation here, then join ${LOCAL_ADDRESS} again.`, colors.yellow)
    }

    const closeBoth = (why: string) => {
      if (localClosed) return
      localClosed = true
      if (!downstreamEnded) endClient(downstream, JSON.stringify({ text: why }))
      endClient(upstream, why)
      logSessionClosed(why)
    }

    const setCompression = (packet: any) => {
      try {
        downstream.write('set_compression', packet)
        ;(downstream as any).compressionThreshold = packet.threshold
      } catch {}
    }

    bridgeLogin(upstream, downstream)
    bridgePlay(upstream, downstream, nicknames, sessionState)

    upstream.on('session', () => {
      upstreamSessionReady = true
      if (detachedAuth) {
        term('Microsoft', `Sign-in complete for ${upstream.username || downstream.username}. Reconnect in Minecraft using ${LOCAL_ADDRESS}.`, colors.green)
      }
    })

    upstream.on('connect', () => {
      upstreamConnected = true
      if (detachedAuth || downstreamEnded) {
        endClient(upstream, 'Client disconnected after Microsoft sign-in')
      }
    })

    upstream.on('packet', (data, meta) => {
      if (meta.name === 'set_compression' || meta.name === 'login.set_compression' || meta.name === 'login.compress') {
        setCompression(data)
      }
    })

    upstream.on('kick_disconnect', packet => {
      if (detachedAuth) return
      try {
        downstream.write('kick_disconnect', packet)
      } catch {}
      closeBoth('Upstream closed the connection')
    })
    upstream.on('end', () => {
      if (!detachedAuth) closeBoth('Upstream ended')
    })
    upstream.on('error', error => {
      if (detachedAuth && isExpectedDisconnectError(error)) return
      if (!isExpectedDisconnectError(error)) console.error('upstream error:', error)
      if (detachedAuth) return
      closeBoth('Upstream error')
    })
    downstream.on('error', error => {
      if (!isExpectedDisconnectError(error)) console.error('downstream error:', error)
      closeBoth('Client error')
    })
    downstream.on('end', () => {
      downstreamEnded = true
      if (microsoftCodeShown && !upstreamSessionReady && !upstreamConnected) {
        keepMicrosoftAuthRunning('Client ended while waiting for Microsoft sign-in')
        return
      }
      closeBoth('Client ended')
    })
  })

  process.on('SIGINT', () => {
    term('Local', 'Shutting down...', colors.magenta)
    try {
      server.close()
    } catch {}
    process.exit(0)
  })

  return server
}

if (require.main === module) {
  startProxy()
}
