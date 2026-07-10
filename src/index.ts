import mc, { Client, Server, ServerClient, ServerOptions } from 'minecraft-protocol'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { AppConfig, RouteId, SplitReminderSettings, UpstreamRoute, createRouteCatalog, loadAppConfig, normalizeAppConfig, normalizeSplitReminderSettings, routeById, saveAppConfig } from './appConfig'
import { apolloChannelRegistrationPacket, apolloJsonPacket, enableApolloNametagMessage, overrideApolloNametagMessage, packetSignalsLunarClient, packetUnregistersApollo, resetAllApolloNametagsMessage, resetApolloNametagMessage } from './apollo'
import { startDashboard } from './dashboard'
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
type AppLogEntry = {
  time: string
  label: string
  message: string
  kind?: 'microsoft_auth' | 'microsoft_auth_complete'
  url?: string
  code?: string
  player?: string
}
type SplitReminderState = {
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
  bedWarsGameActive: boolean
}
type SplitReminderContext = {
  sessionState?: SessionState
  localPlayerName?: string
  log?: (message: string) => void
}
type TeammateDeathResult = {
  match: boolean
  player?: string
  reason?: 'self' | 'non_teammate' | 'no_team' | 'unknown_player'
  team?: TeamState
  teammates?: string[]
}
type LocalTeamSnapshot = {
  primaryTeam: TeamState
  colorName: string | null
  teams: TeamState[]
  playersByKey: Map<string, string>
}
type TransferWatchState = {
  active: boolean
  expiresAt: number
}
type UpstreamStatusSnapshot = {
  routeId: RouteId
  checkedAt: number
  latency: number | null
  pong: any | null
}

loadDotEnv(path.join(process.cwd(), '.env'))

const VERSION = (process.env.MC_VERSION || '1.8.8') as any
const LISTEN_HOST = process.env.LISTEN_HOST || '127.0.0.1'
const LISTEN_PORT = Number(process.env.LISTEN_PORT || 25565)
const STATE_DIR = process.env.STATE_DIR || path.join(process.cwd(), 'state')
const NICKNAME_PATH = path.join(STATE_DIR, 'nicknames.json')
const AUTH_CACHE_DIR = path.join(STATE_DIR, 'auth-cache')
const SERVER_ICON_PATH = path.join(process.cwd(), 'assets', 'server-icon.png')
const LOCAL_ADDRESS = LISTEN_PORT === 25565 ? 'localhost' : `localhost:${LISTEN_PORT}`
const DASHBOARD_HOST = process.env.DASHBOARD_HOST || '127.0.0.1'
const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT || 25765)
const DASHBOARD_ADDRESS = `http://${DASHBOARD_HOST}:${DASHBOARD_PORT}`
const ROUTES = createRouteCatalog(
  process.env.HYPIXEL_HOST || 'mc.hypixel.net',
  Number(process.env.HYPIXEL_PORT || 25565),
  process.env.STOPTHELAG_HOST || 'chi1.qtx.stopthelag.lol',
  Number(process.env.STOPTHELAG_PORT || 25566),
  process.env.HYPIXEL_FAST_HOST || 'mc.hypixel.fast',
  Number(process.env.HYPIXEL_FAST_PORT || 25565)
)
let appConfig: AppConfig = loadAppConfig(STATE_DIR)
const appLogs: AppLogEntry[] = []
const serverIcon = loadServerIcon()
let upstreamStatusCache: UpstreamStatusSnapshot | null = null
let upstreamStatusInFlight: Promise<UpstreamStatusSnapshot> | null = null
let activeSessions = 0
let splitSoundEventId = 0
const VERSION_LABEL = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).version || '1.0.0'
  } catch {
    return '1.0.0'
  }
})()
const BEDWARS_ROSTER_SETTLE_MS = 4000
const MAX_BEDWARS_TEAM_PLAYERS = 4
const SPLIT_PRE_RESPAWN_GRACE_MS = 2500
const BEDWARS_TAB_TEAM_LETTERS: Record<string, string> = {
  R: 'Red',
  B: 'Blue',
  G: 'Green',
  Y: 'Yellow',
  A: 'Aqua',
  W: 'White',
  P: 'Pink',
  S: 'Gray'
}
const LOBBY_COMMAND_DEDUPE_MS = 2500
const RAW_FORWARD_UPSTREAM_PACKETS = new Set(['map_chunk', 'map_chunk_bulk'])
const TRANSFER_WATCH_MS = 20000
const SCOREBOARD_ANALYSIS_THROTTLE_MS = 500
const SPLIT_TITLE_FADE_IN_TICKS = 0
const SPLIT_TITLE_STAY_TICKS = 60
const SPLIT_TITLE_FADE_OUT_TICKS = 10
const SERVER_LIST_PING_CACHE_MS = 5000
const SERVER_LIST_PING_TIMEOUT_MS = 2500

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

function loadServerIcon(): string | undefined {
  if (!fs.existsSync(SERVER_ICON_PATH)) return undefined

  try {
    const base64 = fs.readFileSync(SERVER_ICON_PATH).toString('base64')
    return `data:image/png;base64,${base64}`
  } catch {
    return undefined
  }
}

function color(text: string, ansi: string): string {
  return ansi + text + colors.reset
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

function logEntry(label: string, message: string) {
  appLogs.push({
    time: new Date().toLocaleTimeString('sv-SE', { hour12: false }),
    label,
    message: stripAnsi(message)
  })
  if (appLogs.length > 250) appLogs.splice(0, appLogs.length - 250)
}

function logMicrosoftAuth(player: string, url: string, code: string) {
  appLogs.push({
    time: new Date().toLocaleTimeString('sv-SE', { hour12: false }),
    label: 'Microsoft',
    message: `Sign in as ${player} using ${url} and code ${code}.`,
    kind: 'microsoft_auth',
    url,
    code,
    player
  })
  if (appLogs.length > 250) appLogs.splice(0, appLogs.length - 250)
}

function termMicrosoftAuthComplete(player: string, message: string) {
  appLogs.push({
    time: new Date().toLocaleTimeString('sv-SE', { hour12: false }),
    label: 'Microsoft',
    message: stripAnsi(message),
    kind: 'microsoft_auth_complete',
    player
  })
  if (appLogs.length > 250) appLogs.splice(0, appLogs.length - 250)
  console.log(`${color('Microsoft', colors.green)} ${colors.gray}>${colors.reset} ${message}`)
}

function term(label: string, message: string, labelColor = colors.white) {
  logEntry(label, message)
  console.log(`${color(label, labelColor)} ${colors.gray}>${colors.reset} ${message}`)
}

function currentRoute(): UpstreamRoute {
  return routeById(appConfig.routeId, ROUTES)
}

function updateAppConfig(config: AppConfig): AppConfig {
  appConfig = saveAppConfig(STATE_DIR, config)
  return appConfig
}

function setRoute(routeId: string) {
  const next = updateAppConfig({ ...appConfig, routeId: routeById(routeId, ROUTES).id })
  const route = routeById(next.routeId, ROUTES)
  term('Routing', `Selected ${route.name} (${route.host}:${route.port}) for new connections.`, colors.cyan)
  return dashboardStatus()
}

function setSplitReminderEnabled(enabled: boolean) {
  updateAppConfig({
    ...appConfig,
    splitReminder: normalizeSplitReminderSettings({ ...appConfig.splitReminder, enabled })
  })
  term('QoL', `Split reminder ${enabled ? 'enabled' : 'disabled'}.`, colors.yellow)
  return dashboardStatus()
}

function dashboardStatus() {
  const route = currentRoute()
  return {
    version: VERSION_LABEL,
    localAddress: LOCAL_ADDRESS,
    dashboardAddress: DASHBOARD_ADDRESS,
    activeSessions,
    route,
    routes: ROUTES,
    splitReminder: appConfig.splitReminder,
    logs: appLogs.slice(-120)
  }
}

function printLauncherHeader() {
  const route = currentRoute()
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
  term('Routing', `${route.name}: ${route.host}:${route.port}`, colors.cyan)
  term('Dashboard', DASHBOARD_ADDRESS, colors.green)
  console.log('')
}

function logSessionClosed(why: string) {
  term('Local', `Session closed: ${why}`, colors.magenta)
}

function stripColors(text: string): string {
  return text.replace(/\u00a7[0-9A-FK-ORa-fk-or]/g, '')
}

function validPlayerName(name: string): boolean {
  return /^[A-Za-z0-9_]{1,16}$/.test(name)
}

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true })
  fs.mkdirSync(AUTH_CACHE_DIR, { recursive: true })
}

function authCachePrefixForUsername(username: string): string {
  return crypto.createHash('sha1').update(username || '', 'binary').digest('hex').slice(0, 6)
}

function clearAuthCacheForUsername(username: string): number {
  ensureStateDir()
  const prefix = `${authCachePrefixForUsername(username)}_`
  let removed = 0

  for (const file of fs.readdirSync(AUTH_CACHE_DIR)) {
    if (!file.startsWith(prefix) || !file.endsWith('-cache.json')) continue
    try {
      fs.unlinkSync(path.join(AUTH_CACHE_DIR, file))
      removed += 1
    } catch {}
  }

  return removed
}

function microsoftAccountMismatchReason(expected: string, actual: string): string {
  return `Microsoft account mismatch: Minecraft selected ${expected}, but the proxy authenticated as ${actual}. Reconnect and sign in with the Microsoft account for ${expected}.`
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
  if (Array.isArray(comp)) return comp.map(flattenChatToText).join('')

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

function createSplitReminderState(): SplitReminderState {
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
    bedWarsGameActive: false
  }
}

function resetSplitReminderMatchState(state: SplitReminderState, bedWarsGameActive = false, now = Date.now()) {
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
  state.bedWarsGameActive = bedWarsGameActive
}

function safePatternMatch(text: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    try {
      if (new RegExp(pattern, 'i').test(text)) return true
    } catch {}
  }
  return false
}

function containsRespawnedText(text: string, settings: SplitReminderSettings): boolean {
  return new RegExp(`\\b${escapeRegExp(settings.respawnedText)}\\b`, 'i').test(stripColors(text))
}

function isRespawnedTitleText(text: string, settings: SplitReminderSettings): boolean {
  return new RegExp(`^\\s*${escapeRegExp(settings.respawnedText)}[.!?]?\\s*$`, 'i').test(stripColors(text))
}

function isLocalDeathText(text: string, settings: SplitReminderSettings): boolean {
  return safePatternMatch(stripColors(text), settings.localDeathPatterns)
}

function isTeammateDeathText(text: string, settings: SplitReminderSettings): boolean {
  const clean = stripColors(text)
  if (isLocalDeathText(clean, settings)) return false
  return safePatternMatch(clean, settings.teammateDeathPatterns)
}

function isLocalRespawnCountdownText(text: string): boolean {
  return /\byou will respawn in \d+ seconds?[.!]?$/i.test(stripColors(text).trim())
}

function isLocalRespawnCompleteText(text: string): boolean {
  return /\byou have respawned[.!]?$/i.test(stripColors(text).trim())
}

function bedWarsGameEvent(text: string): 'start' | 'end' | 'pregame' | null {
  const clean = stripColors(text).trim()
  if (!clean) return null

  if (/^(?:VICTORY|DEFEAT|GAME OVER)[!]?$/i.test(clean)) return 'end'
  if (/\bProtect your bed and destroy the enemy beds\b/i.test(clean)) return 'start'
  if (/\bYou are now (?:on|in) (?:the )?(?:Red|Blue|Green|Yellow|Aqua|White|Pink|Gray|Grey) team\b/i.test(clean)) return 'pregame'
  if (/\bYou joined (?:the )?(?:Red|Blue|Green|Yellow|Aqua|White|Pink|Gray|Grey) team\b/i.test(clean)) return 'pregame'
  if (/\bThe game starts in \d+ seconds?\b/i.test(clean)) return 'pregame'

  return null
}

function bedWarsTeamModeFromText(text: string): { label: string; maxPlayers: number } | null {
  const clean = stripColors(text)
  if (/\b4v4v4v4\b/i.test(clean)) return { label: '4v4v4v4', maxPlayers: 4 }
  if (/\b4v4\b/i.test(clean)) return { label: '4v4', maxPlayers: 4 }
  if (/\b3v3v3v3\b/i.test(clean)) return { label: '3v3v3v3', maxPlayers: 3 }
  if (/\b3v3\b/i.test(clean)) return { label: '3v3', maxPlayers: 3 }
  if (/\b2v2v2v2v2v2v2v2\b/i.test(clean)) return { label: 'Doubles', maxPlayers: 2 }
  if (/\b(?:doubles?|2v2)\b/i.test(clean)) return { label: 'Doubles', maxPlayers: 2 }
  if (/\b1v1v1v1v1v1v1v1\b/i.test(clean)) return { label: 'Solo', maxPlayers: 1 }
  if (/\bsolo\b/i.test(clean)) return { label: 'Solo', maxPlayers: 1 }
  return null
}

function bedWarsTeamMaxPlayersFromText(text: string): number {
  return bedWarsTeamModeFromText(text)?.maxPlayers || 0
}

function applyBedWarsTeamModeFromText(
  text: string,
  state: SplitReminderState
): { label: string; maxPlayers: number } | null {
  const mode = bedWarsTeamModeFromText(text)
  if (!mode) return null

  const source = `mode:${mode.label}`
  if (
    state.bedWarsGameActive &&
    state.stableTeamMaxPlayersSource.startsWith('mode:') &&
    state.stableTeamMaxPlayersSource !== source
  ) {
    return null
  }

  if (state.stableTeamMaxPlayers === mode.maxPlayers && state.stableTeamMaxPlayersSource === source) {
    return null
  }

  state.stableTeamMaxPlayers = mode.maxPlayers
  state.stableTeamMaxPlayersSource = source
  return mode
}

function updateBedWarsGameStateFromText(
  text: string,
  state: SplitReminderState,
  sessionState?: SessionState,
  now = Date.now(),
  localPlayerName?: string
): 'start' | 'end' | 'pregame' | null {
  const textMode = bedWarsTeamModeFromText(text)
  const event = bedWarsGameEvent(text)
  if (!event) {
    applyBedWarsTeamModeFromText(text, state)
    return null
  }

  if (event === 'pregame' && state.bedWarsGameActive) {
    state.bedWarsPregameSeenAt = now
    return null
  }

  if (event === 'start' && state.bedWarsGameActive && state.bedWarsPregameSeenAt <= state.bedWarsGameStartedAt) {
    applyBedWarsTeamModeFromText(text, state)
    return null
  }

  const pendingMaxPlayers = event === 'start'
    ? textMode?.maxPlayers || state.stableTeamMaxPlayers
    : textMode?.maxPlayers || 0
  const pendingSource = event === 'start'
    ? textMode ? `mode:${textMode.label}` : state.stableTeamMaxPlayersSource
    : textMode ? `mode:${textMode.label}` : ''
  if (event === 'start' || event === 'pregame') {
    retainLocalBedWarsTabTeams(sessionState, localPlayerName)
  } else {
    sessionState?.teams.clear()
  }

  if (event === 'start') {
    resetSplitReminderMatchState(state, true, now)
    state.stableTeamMaxPlayers = pendingMaxPlayers
    state.stableTeamMaxPlayersSource = pendingSource
    return event
  }

  resetSplitReminderMatchState(state, false, now)
  state.stableTeamMaxPlayers = pendingMaxPlayers
  state.stableTeamMaxPlayersSource = pendingSource
  return event
}

function playerKey(name: string): string {
  return stripColors(name).trim().toLowerCase()
}

function teamHasPlayer(team: TeamState, playerName: string): boolean {
  const target = playerKey(playerName)
  for (const player of team.players) {
    if (playerKey(player) === target) return true
  }
  return false
}

function addLocalTeamPlayer(playersByKey: Map<string, string>, playerName: string) {
  const clean = stripColors(playerName).trim()
  if (!validPlayerName(clean)) return
  playersByKey.set(playerKey(clean), clean)
}

function bedWarsTabTeamLetterFromText(text: string): string | null {
  const clean = stripColors(text).replace(/\s+/g, ' ').trim()
  if (!clean) return null

  const match = /(?:^|[^A-Za-z0-9_])([RBGYAWPS])(?:$|[^A-Za-z0-9_])/i.exec(clean)
  return match ? match[1].toUpperCase() : null
}

function bedWarsTabTeamLetter(team: TeamState): string | null {
  return bedWarsTabTeamLetterFromText(team.prefix || '')
    || bedWarsTabTeamLetterFromText(team.suffix || '')
    || bedWarsTabTeamLetterFromText(team.team || '')
}

function bedWarsTabTeamName(team: TeamState): string | null {
  const letter = bedWarsTabTeamLetter(team)
  return letter ? BEDWARS_TAB_TEAM_LETTERS[letter] || null : null
}

function playerDisplayText(player: any): string {
  if (!player || typeof player !== 'object' || player.displayName == null) return ''
  return stripColors(flattenChatToText(player.displayName)).replace(/\s+/g, ' ').trim()
}

function bedWarsTabTeamLetterFromPlayerInfo(player: any): string | null {
  const name = typeof player?.name === 'string' ? player.name : ''
  const display = playerDisplayText(player)
  if (!display) return null

  if (validPlayerName(name)) {
    const match = new RegExp(`(?:^|[^A-Za-z0-9_])([RBGYAWPS])\\s+${escapeRegExp(name)}(?:$|[^A-Za-z0-9_])`, 'i').exec(display)
    if (match) return match[1].toUpperCase()
  }

  return bedWarsTabTeamLetterFromText(display)
}

function addLocalTeamPlayersFromTabLetter(
  state: SessionState,
  playersByKey: Map<string, string>,
  letter: string
) {
  for (const team of state.teams.values()) {
    if (bedWarsTabTeamLetter(team) !== letter) continue
    for (const player of team.players) addLocalTeamPlayer(playersByKey, player)
  }

  for (const player of state.playersByName.values()) {
    if (bedWarsTabTeamLetterFromPlayerInfo(player) !== letter) continue
    if (typeof player?.name === 'string') addLocalTeamPlayer(playersByKey, player.name)
  }
}

function splitSoundStatus() {
  return { eventId: splitSoundEventId }
}

function retainLocalBedWarsTabTeams(state?: SessionState, localPlayerName?: string) {
  if (!state) return
  if (!localPlayerName) {
    state.teams.clear()
    return
  }

  const localPlayer = state.playersByName.get(playerKey(localPlayerName))
  const localLetter = localPlayerTeamCandidates(state, localPlayerName)
    .map(bedWarsTabTeamLetter)
    .find((letter): letter is string => !!letter)
    || bedWarsTabTeamLetterFromPlayerInfo(localPlayer)

  if (!localLetter) {
    state.teams.clear()
    return
  }

  for (const [teamName, team] of state.teams) {
    const teamLetter = bedWarsTabTeamLetter(team)
    const playerLetterMatches = Array.from(team.players).some(player => {
      return bedWarsTabTeamLetterFromPlayerInfo(state.playersByName.get(playerKey(player))) === localLetter
    })
    if (teamLetter !== localLetter && !playerLetterMatches && !teamHasPlayer(team, localPlayerName)) {
      state.teams.delete(teamName)
    }
  }
}

function localPlayerTeamCandidates(state: SessionState, localPlayerName: string): TeamState[] {
  const teams = Array.from(state.teams.values()).filter(team => teamHasPlayer(team, localPlayerName))
  if (!teams.length) return []

  teams.sort((a, b) => {
    const aUseful = a.players.size > 1 ? 0 : 1
    const bUseful = b.players.size > 1 ? 0 : 1
    if (aUseful !== bUseful) return aUseful - bUseful
    if (a.players.size !== b.players.size) return a.players.size - b.players.size
    return a.team.localeCompare(b.team)
  })
  return teams
}

function legacyColorName(text: string): string | null {
  const colorNames: Record<string, string> = {
    c: 'Red',
    9: 'Blue',
    a: 'Green',
    e: 'Yellow',
    b: 'Aqua',
    f: 'White',
    d: 'Pink',
    7: 'Gray'
  }
  const colorCode = /\u00a7([0-9a-f])/i.exec(text)
  return colorCode ? colorNames[colorCode[1].toLowerCase()] || null : null
}

function jsonColorName(colorName: unknown): string | null {
  if (typeof colorName !== 'string') return null
  const colorsByName: Record<string, string> = {
    red: 'Red',
    blue: 'Blue',
    green: 'Green',
    yellow: 'Yellow',
    aqua: 'Aqua',
    white: 'White',
    light_purple: 'Pink',
    gray: 'Gray',
    grey: 'Gray',
    dark_gray: 'Gray'
  }
  return colorsByName[colorName.toLowerCase()] || null
}

function chatComponentColorName(value: any): string | null {
  if (typeof value === 'string') {
    const legacy = legacyColorName(value)
    if (legacy) return legacy

    try {
      return chatComponentColorName(JSON.parse(value))
    } catch {
      return null
    }
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const color = chatComponentColorName(item)
      if (color) return color
    }
    return null
  }

  if (!value || typeof value !== 'object') return null

  const direct = jsonColorName(value.color)
  if (direct) return direct

  for (const key of ['extra', 'with']) {
    if (!Array.isArray(value[key])) continue
    const nested = chatComponentColorName(value[key])
    if (nested) return nested
  }

  return null
}

function playerDisplayColorName(player: any): string | null {
  if (!player || typeof player !== 'object') return null
  return chatComponentColorName(player.displayName)
}

function playerStateColorName(state: SessionState, playerName: string): string | null {
  const player = state.playersByName.get(playerKey(playerName))
  return playerDisplayColorName(player)
}

function teamIncludesColorName(state: SessionState, team: TeamState, colorName: string): boolean {
  const teamColor = teamColorName(team)
  if (teamColor) return teamColor === colorName

  for (const player of team.players) {
    if (playerStateColorName(state, player) === colorName) return true
  }
  return false
}

function addLocalTeamPlayersFromTeam(
  state: SessionState,
  playersByKey: Map<string, string>,
  team: TeamState,
  colorName: string | null
) {
  const teamColor = teamColorName(team)

  for (const player of team.players) {
    if (colorName && !teamColor && playerStateColorName(state, player) !== colorName) continue
    addLocalTeamPlayer(playersByKey, player)
  }
}

function localPlayerTeamSnapshotForCandidate(
  state: SessionState,
  localPlayerName: string,
  primaryTeam: TeamState
): LocalTeamSnapshot {
  const tabLetter = bedWarsTabTeamLetter(primaryTeam)
    || bedWarsTabTeamLetterFromPlayerInfo(state.playersByName.get(playerKey(localPlayerName)))
  const colorName = (tabLetter ? BEDWARS_TAB_TEAM_LETTERS[tabLetter] || null : null)
    || teamColorName(primaryTeam)
    || playerStateColorName(state, localPlayerName)
  const teams = tabLetter
    ? Array.from(state.teams.values()).filter(team => bedWarsTabTeamLetter(team) === tabLetter)
    : colorName
      ? Array.from(state.teams.values()).filter(team => teamIncludesColorName(state, team, colorName))
      : [primaryTeam]
  const playersByKey = new Map<string, string>()

  if (tabLetter) {
    addLocalTeamPlayersFromTabLetter(state, playersByKey, tabLetter)
  } else {
    for (const team of teams) {
      addLocalTeamPlayersFromTeam(state, playersByKey, team, colorName)
    }
  }

  addLocalTeamPlayer(playersByKey, localPlayerName)

  return {
    primaryTeam,
    colorName,
    teams,
    playersByKey
  }
}

function localTeamSnapshotRank(snapshot: LocalTeamSnapshot): number[] {
  const size = snapshot.playersByKey.size
  const plausibleBedWarsSize = size >= 2 && size <= 4 ? 0 : 1
  const knownColor = snapshot.colorName ? 0 : 1
  const sizeScore = size <= 4 ? -size : size
  return [plausibleBedWarsSize, knownColor, sizeScore, snapshot.primaryTeam.team.length]
}

function compareLocalTeamSnapshots(a: LocalTeamSnapshot, b: LocalTeamSnapshot): number {
  const left = localTeamSnapshotRank(a)
  const right = localTeamSnapshotRank(b)
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i]
  }
  return a.primaryTeam.team.localeCompare(b.primaryTeam.team)
}

function currentSnapshotTeamKey(snapshot: LocalTeamSnapshot): string {
  return snapshot.colorName || snapshot.primaryTeam.team
}

function scoreboardColorGroups(state: SessionState): Map<string, Set<string>> {
  const groups = new Map<string, Set<string>>()

  for (const team of state.teams.values()) {
    const teamColor = teamColorName(team)
    for (const player of team.players) {
      const colorName = teamColor || playerStateColorName(state, player)
      if (!colorName) continue

      let players = groups.get(colorName)
      if (!players) {
        players = new Set()
        groups.set(colorName, players)
      }
      const clean = stripColors(player).trim()
      if (validPlayerName(clean)) players.add(playerKey(clean))
    }
  }

  return groups
}

function inferBedWarsTeamMaxPlayers(state: SessionState, snapshot: LocalTeamSnapshot): number {
  const groups = Array.from(scoreboardColorGroups(state).values())
    .map(players => players.size)
    .filter(size => size > 0 && size <= MAX_BEDWARS_TEAM_PLAYERS)
  const colorCount = groups.length
  const largestGroup = Math.max(snapshot.playersByKey.size, ...groups, 0)

  if (largestGroup >= 4) return 4
  if (colorCount >= 6) return largestGroup >= 2 ? 2 : 1
  if (colorCount > 0 && colorCount <= 4 && largestGroup >= 3) return 4
  if (largestGroup >= 2) return Math.min(largestGroup, MAX_BEDWARS_TEAM_PLAYERS)
  return MAX_BEDWARS_TEAM_PLAYERS
}

function inferBedWarsModeFromScoreboardGroups(state: SessionState): { label: string; maxPlayers: number } | null {
  const sizes = Array.from(scoreboardColorGroups(state).values())
    .map(players => players.size)
    .filter(size => size > 0 && size <= MAX_BEDWARS_TEAM_PLAYERS)

  if (!sizes.length) return null

  const largestGroup = Math.max(...sizes)
  const fullGroups = (size: number) => sizes.filter(groupSize => groupSize === size).length

  if (largestGroup >= 4) return { label: '4v4v4v4', maxPlayers: 4 }
  if (largestGroup === 3 && fullGroups(3) >= 2) return { label: '3v3v3v3', maxPlayers: 3 }
  if (largestGroup === 2 && fullGroups(2) >= 4) return { label: 'Doubles', maxPlayers: 2 }
  if (largestGroup === 1 && sizes.length >= 6) return { label: 'Solo', maxPlayers: 1 }

  return null
}

function applyBedWarsTeamModeFromScoreboardGroups(
  state: SessionState,
  splitState: SplitReminderState
): { label: string; maxPlayers: number } | null {
  if (!splitState.bedWarsGameActive) return null
  if (splitState.stableTeamMaxPlayersSource.startsWith('mode:')) return null

  const mode = inferBedWarsModeFromScoreboardGroups(state)
  if (!mode) return null

  const source = `mode:${mode.label}`
  if (splitState.stableTeamMaxPlayers === mode.maxPlayers && splitState.stableTeamMaxPlayersSource === source) {
    return null
  }

  splitState.stableTeamMaxPlayers = mode.maxPlayers
  splitState.stableTeamMaxPlayersSource = source
  return mode
}

function maybeSettleTeamMaxPlayers(
  splitState: SplitReminderState,
  state: SessionState,
  snapshot: LocalTeamSnapshot,
  now: number
) {
  if (splitState.stableTeamMaxPlayersSource.startsWith('mode:')) return
  if (splitState.stableTeamMaxPlayersSource === 'inferred' && splitState.stableTeamMaxPlayers) {
    splitState.stableTeamMaxPlayers = Math.min(
      MAX_BEDWARS_TEAM_PLAYERS,
      Math.max(
        splitState.stableTeamMaxPlayers,
        snapshot.playersByKey.size,
        splitState.stableTeamPlayersByKey.size
      )
    )
    return
  }
  if (splitState.stableTeamMaxPlayers) return
  if (!splitState.bedWarsGameStartedAt || now - splitState.bedWarsGameStartedAt < BEDWARS_ROSTER_SETTLE_MS) return
  splitState.stableTeamMaxPlayers = Math.min(
    MAX_BEDWARS_TEAM_PLAYERS,
    Math.max(
      inferBedWarsTeamMaxPlayers(state, snapshot),
      snapshot.playersByKey.size,
      splitState.stableTeamPlayersByKey.size
    )
  )
  splitState.stableTeamMaxPlayersSource = 'inferred'
}

function stableTeamPlayerCap(splitState: SplitReminderState): number {
  return splitState.stableTeamMaxPlayers || MAX_BEDWARS_TEAM_PLAYERS
}

function setStableTeamPlayers(splitState: SplitReminderState, players: Map<string, string>) {
  splitState.stableTeamPlayersByKey.clear()
  for (const [key, player] of players) splitState.stableTeamPlayersByKey.set(key, player)
}

function trimStableTeamPlayers(splitState: SplitReminderState, localPlayerName: string) {
  const cap = stableTeamPlayerCap(splitState)
  if (splitState.stableTeamPlayersByKey.size <= cap) return

  const localKey = playerKey(localPlayerName)
  const next = new Map<string, string>()
  const localPlayer = splitState.stableTeamPlayersByKey.get(localKey)
  if (localPlayer) next.set(localKey, localPlayer)

  for (const [key, player] of splitState.stableTeamPlayersByKey) {
    if (next.size >= cap) break
    if (key === localKey) continue
    next.set(key, player)
  }

  setStableTeamPlayers(splitState, next)
}

function addStableTeamPlayer(splitState: SplitReminderState, playerName: string, force = false) {
  const clean = stripColors(playerName).trim()
  if (!validPlayerName(clean)) return
  const key = playerKey(clean)
  if (!force && !splitState.stableTeamPlayersByKey.has(key) && splitState.stableTeamPlayersByKey.size >= stableTeamPlayerCap(splitState)) {
    return
  }
  splitState.stableTeamPlayersByKey.set(key, clean)
}

function withStableLocalTeamSnapshot(
  snapshot: LocalTeamSnapshot,
  splitState: SplitReminderState | undefined,
  state: SessionState,
  localPlayerName: string,
  now = Date.now()
): LocalTeamSnapshot {
  if (!splitState) return snapshot
  if (!splitState.bedWarsGameActive) return snapshot

  const teamKey = currentSnapshotTeamKey(snapshot)
  if (!splitState.stableTeamColorName && snapshot.playersByKey.size < 2) {
    return snapshot
  }

  if (splitState.stableTeamColorName && splitState.stableTeamColorName !== teamKey) {
    return {
      ...snapshot,
      colorName: splitState.stableTeamColorName,
      playersByKey: new Map(splitState.stableTeamPlayersByKey)
    }
  }

  if (!splitState.stableTeamColorName) splitState.stableTeamColorName = teamKey

  maybeSettleTeamMaxPlayers(splitState, state, snapshot, now)
  addStableTeamPlayer(splitState, localPlayerName, true)

  for (const player of snapshot.playersByKey.values()) {
    addStableTeamPlayer(splitState, player)
  }
  trimStableTeamPlayers(splitState, localPlayerName)

  return {
    ...snapshot,
    playersByKey: new Map(splitState.stableTeamPlayersByKey)
  }
}

function cachedLocalTeamSnapshot(splitState: SplitReminderState): LocalTeamSnapshot | null {
  if (!splitState.bedWarsGameActive || !splitState.stableTeamColorName || !splitState.stableTeamPlayersByKey.size) {
    return null
  }

  const team: TeamState = {
    team: splitState.stableTeamColorName,
    packetName: 'scoreboard_team',
    prefix: '',
    suffix: '',
    players: new Set(splitState.stableTeamPlayersByKey.values()),
    sentPlayers: new Set(splitState.stableTeamPlayersByKey.values())
  }

  return {
    primaryTeam: team,
    colorName: splitState.stableTeamColorName,
    teams: [team],
    playersByKey: new Map(splitState.stableTeamPlayersByKey)
  }
}

function localPlayerTeamSnapshot(
  state: SessionState,
  localPlayerName: string,
  splitState?: SplitReminderState,
  now = Date.now()
): LocalTeamSnapshot | null {
  if (splitState && !splitState.bedWarsGameActive) return null

  const candidates = localPlayerTeamCandidates(state, localPlayerName)
  if (!candidates.length) return splitState ? cachedLocalTeamSnapshot(splitState) : null

  const snapshots = candidates
    .map(team => localPlayerTeamSnapshotForCandidate(state, localPlayerName, team))
    .filter(snapshot => snapshot.playersByKey.size <= MAX_BEDWARS_TEAM_PLAYERS || !!splitState?.stableTeamMaxPlayers)
    .sort(compareLocalTeamSnapshots)
  const snapshot = splitState?.stableTeamColorName
    ? snapshots.find(snapshot => currentSnapshotTeamKey(snapshot) === splitState.stableTeamColorName) || snapshots[0] || null
    : snapshots[0] || null

  return snapshot
    ? withStableLocalTeamSnapshot(snapshot, splitState, state, localPlayerName, now)
    : splitState ? cachedLocalTeamSnapshot(splitState) : null
}

function localTeamPlayerNames(snapshot: LocalTeamSnapshot): string[] {
  return Array.from(snapshot.playersByKey.values()).sort((a, b) => a.localeCompare(b))
}

function localTeamHasPlayer(snapshot: LocalTeamSnapshot, playerName: string): boolean {
  return snapshot.playersByKey.has(playerKey(playerName))
}

function localPlayerTeam(state: SessionState, localPlayerName: string): TeamState | null {
  return localPlayerTeamSnapshot(state, localPlayerName)?.primaryTeam || null
}

function deathPlayerName(message: string): string | null {
  const clean = stripColors(message).trim()
  if (/^you\b/i.test(clean)) return null
  const match = /^([A-Za-z0-9_]{1,16})\b/.exec(clean)
  return match ? match[1] : null
}

function isLocalPlayerDeathText(text: string, settings: SplitReminderSettings, localPlayerName?: string): boolean {
  if (!localPlayerName || !isTeammateDeathText(text, settings)) return false
  const player = deathPlayerName(text)
  return !!player && playerKey(player) === playerKey(localPlayerName)
}

function isLocalTeammateDeathText(
  text: string,
  settings: SplitReminderSettings,
  sessionState?: SessionState,
  localPlayerName?: string,
  splitState?: SplitReminderState,
  now = Date.now()
): TeammateDeathResult {
  if (!isTeammateDeathText(text, settings)) return { match: false }

  const player = deathPlayerName(text)
  if (!player) return { match: false, reason: 'unknown_player' }
  if (localPlayerName && playerKey(player) === playerKey(localPlayerName)) {
    return { match: false, player, reason: 'self' }
  }
  if (!sessionState || !localPlayerName) {
    return { match: false, player, reason: 'no_team' }
  }
  if (splitState && !splitState.bedWarsGameActive) {
    return { match: false, player, reason: 'no_team' }
  }

  if (splitState?.bedWarsGameActive && splitState.stableTeamPlayersByKey.has(playerKey(player))) {
    const cachedTeam = cachedLocalTeamSnapshot(splitState)
    const teammates = cachedTeam
      ? localTeamPlayerNames(cachedTeam)
      : Array.from(splitState.stableTeamPlayersByKey.values()).sort((a, b) => a.localeCompare(b))
    return { match: true, player, team: cachedTeam?.primaryTeam, teammates }
  }

  const localTeam = localPlayerTeamSnapshot(sessionState, localPlayerName, splitState, now)
  if (!localTeam) return { match: false, player, reason: 'no_team' }
  const teammates = localTeamPlayerNames(localTeam)
  if (localTeamHasPlayer(localTeam, player)) {
    return { match: true, player, team: localTeam.primaryTeam, teammates }
  }

  return { match: false, player, reason: 'non_teammate', team: localTeam.primaryTeam, teammates }
}

function replaceRespawnedText(text: string, settings: SplitReminderSettings): string {
  const replacement = /[.!?]$/.test(settings.replacementText)
    ? settings.replacementText
    : `${settings.replacementText}!`
  return text.replace(
    new RegExp(`^(\\s*)${escapeRegExp(settings.respawnedText)}[.!?]?(\\s*)$`, 'i'),
    `$1${replacement}$2`
  )
}

function replaceRespawnedInTitle(comp: any, settings: SplitReminderSettings): any {
  if (typeof comp === 'string') return replaceRespawnedText(comp, settings)
  if (Array.isArray(comp)) return { text: replaceRespawnedText(flattenChatToText(comp), settings) }
  if (!comp || typeof comp !== 'object') return comp

  const copy: any = { ...comp }
  copy.text = replaceRespawnedText(flattenChatToText(comp), settings)
  delete copy.extra
  delete copy.with
  return copy
}

function withSplitReminderChatComponent(
  comp: any,
  state: SplitReminderState,
  settings: SplitReminderSettings,
  now = Date.now(),
  context: SplitReminderContext = {}
): any {
  if (!settings.enabled) return comp

  const text = flattenChatToText(comp)
  if (!text.trim()) return comp

  if (updateBedWarsGameStateFromText(text, state, context.sessionState, now, context.localPlayerName)) {
    return comp
  }

  if (isLocalRespawnCountdownText(text)) {
    const preRespawnTriggerIsFresh =
      !!state.preRespawnTrigger &&
      now - state.preRespawnTriggerAt <= SPLIT_PRE_RESPAWN_GRACE_MS
    if (!state.respawning) {
      state.splitPending = preRespawnTriggerIsFresh
      state.lastTrigger = preRespawnTriggerIsFresh ? state.preRespawnTrigger : ''
      if (preRespawnTriggerIsFresh) state.splitSignalId += 1
    }
    state.preRespawnTrigger = ''
    state.preRespawnTriggerAt = 0
    state.respawning = true
    return comp
  }

  if (isLocalRespawnCompleteText(text)) {
    state.respawning = false
    state.preRespawnTrigger = ''
    state.preRespawnTriggerAt = 0
    return comp
  }

  if (isLocalDeathText(text, settings) || isLocalPlayerDeathText(text, settings, context.localPlayerName)) {
    if (!state.respawning) {
      state.splitPending = false
      state.lastTrigger = ''
    }
    return comp
  }

  const teammateDeath = isTeammateDeathText(text, settings)
    ? isLocalTeammateDeathText(
      text,
      settings,
      context.sessionState,
      context.localPlayerName,
      state,
      now
    )
    : { match: false } as TeammateDeathResult

  if (state.respawning) {
    if (teammateDeath.match) {
      const isNewTrigger = state.lastTrigger !== text
      state.splitPending = true
      state.lastTrigger = text
      state.preRespawnTrigger = ''
      state.preRespawnTriggerAt = 0
      if (isNewTrigger) state.splitSignalId += 1
      return comp
    }

    if (teammateDeath.player && teammateDeath.reason === 'non_teammate') {
      const seenTeammates = teammateDeath.teammates?.length
        ? ` Teammates: ${teammateDeath.teammates.join(', ')}.`
        : ''
      context.log?.(`Ignored split trigger from non-teammate ${teammateDeath.player}.${seenTeammates}`)
      return comp
    }

    if (teammateDeath.player && teammateDeath.reason === 'no_team') {
      context.log?.(`Ignored split trigger from ${teammateDeath.player}; local team not detected.`)
      return comp
    }
  }

  if (teammateDeath.match) {
    state.preRespawnTrigger = text
    state.preRespawnTriggerAt = now
  }

  return comp
}

function withSplitReminderTitleComponent(
  comp: any,
  state: SplitReminderState,
  settings: SplitReminderSettings,
  now = Date.now()
): any {
  if (!settings.enabled) return comp

  const text = flattenChatToText(comp)
  if (!text.trim() || !isRespawnedTitleText(text, settings)) return comp

  const shouldSplit = state.splitPending
  state.splitPending = false
  state.respawning = false
  state.lastTrigger = ''
  state.preRespawnTrigger = ''
  state.preRespawnTriggerAt = 0

  return shouldSplit ? replaceRespawnedInTitle(comp, settings) : comp
}

function withSplitReminderTitleString(
  text: unknown,
  state: SplitReminderState,
  settings: SplitReminderSettings,
  now = Date.now()
): unknown {
  if (typeof text !== 'string') return text
  try {
    return JSON.stringify(withSplitReminderTitleComponent(JSON.parse(text), state, settings, now))
  } catch {
    return withSplitReminderTitleComponent(text, state, settings, now)
  }
}

function withSplitReminderPacket(
  packetName: string,
  packet: any,
  state: SplitReminderState,
  settings: SplitReminderSettings,
  now = Date.now(),
  sessionState?: SessionState,
  localPlayerName?: string
): any {
  if (!packet || typeof packet !== 'object') return packet
  if (packetName !== 'title' && packetName !== 'set_title_text' && packetName !== 'set_title_subtitle' && packetName !== 'set_action_bar_text') {
    return packet
  }

  if (updateBedWarsGameStateFromText(flattenChatToText(packet), state, sessionState, now, localPlayerName)) {
    return packet
  }

  let changed = false
  const next = { ...packet }
  for (const field of ['text', 'title', 'subtitle', 'actionBarText']) {
    const updated = withSplitReminderTitleString(next[field], state, settings, now)
    if (updated !== next[field]) {
      next[field] = updated
      changed = true
    }
  }

  if (!changed && state.splitPending) {
    const fallback = withSplitReminderUnknownPacket(next, state, settings, now)
    if (fallback.changed) return fallback.packet
  }

  return changed ? next : packet
}

function rewriteRespawnedString(value: string, settings: SplitReminderSettings): string {
  if (isRespawnedTitleText(value, settings)) return replaceRespawnedText(value, settings)

  try {
    const parsed = JSON.parse(value)
    if (!isRespawnedTitleText(flattenChatToText(parsed), settings)) return value
    return JSON.stringify(replaceRespawnedInTitle(parsed, settings))
  } catch {
    return value
  }
}

function rewriteRespawnedPacketText(value: any, settings: SplitReminderSettings): { value: any; changed: boolean } {
  if (typeof value === 'string') {
    const next = rewriteRespawnedString(value, settings)
    return { value: next, changed: next !== value }
  }

  if (Array.isArray(value)) {
    let changed = false
    const next = value.map(item => {
      const result = rewriteRespawnedPacketText(item, settings)
      changed = changed || result.changed
      return result.value
    })
    return { value: changed ? next : value, changed }
  }

  if (!value || typeof value !== 'object') return { value, changed: false }

  let changed = false
  const next: any = { ...value }
  for (const key of Object.keys(next)) {
    const result = rewriteRespawnedPacketText(next[key], settings)
    if (result.changed) {
      next[key] = result.value
      changed = true
    }
  }
  return { value: changed ? next : value, changed }
}

function respawnedPacketSnippets(value: any, settings: SplitReminderSettings, snippets: string[] = []): string[] {
  if (snippets.length >= 3 || value == null) return snippets

  if (typeof value === 'string') {
    const plain = stripColors(value)
    if (containsRespawnedText(plain, settings)) snippets.push(plain)
    try {
      const flattened = stripColors(flattenChatToText(JSON.parse(value)))
      if (flattened && containsRespawnedText(flattened, settings) && !snippets.includes(flattened)) {
        snippets.push(flattened)
      }
    } catch {}
    return snippets
  }

  if (Array.isArray(value)) {
    for (const item of value) respawnedPacketSnippets(item, settings, snippets)
    return snippets
  }

  if (typeof value === 'object') {
    const flattened = stripColors(flattenChatToText(value))
    if (flattened && containsRespawnedText(flattened, settings) && !snippets.includes(flattened)) {
      snippets.push(flattened)
    }
    for (const item of Object.values(value)) respawnedPacketSnippets(item, settings, snippets)
  }

  return snippets
}

function packetHasRespawnedTitleText(value: any, settings: SplitReminderSettings): boolean {
  if (value == null) return false

  if (typeof value === 'string') {
    if (isRespawnedTitleText(value, settings)) return true
    try {
      return packetHasRespawnedTitleText(JSON.parse(value), settings)
    } catch {
      return false
    }
  }

  if (Array.isArray(value)) {
    if (isRespawnedTitleText(flattenChatToText(value), settings)) return true
    return value.some(item => packetHasRespawnedTitleText(item, settings))
  }

  if (typeof value === 'object') {
    if (isRespawnedTitleText(flattenChatToText(value), settings)) return true
    return Object.values(value).some(item => packetHasRespawnedTitleText(item, settings))
  }

  return false
}

function splitTitleText(settings: SplitReminderSettings): string {
  return /[.!?]$/.test(settings.replacementText)
    ? settings.replacementText
    : `${settings.replacementText}!`
}

function splitTitleTimingPacket(packetName = 'title'): any | null {
  if (packetName !== 'title') return null
  return {
    action: 2,
    fadeIn: SPLIT_TITLE_FADE_IN_TICKS,
    stay: SPLIT_TITLE_STAY_TICKS,
    fadeOut: SPLIT_TITLE_FADE_OUT_TICKS
  }
}

function splitTitleSubtitlePacket(packetName = 'title'): any | null {
  if (packetName !== 'title' && packetName !== 'set_title_subtitle') return null
  return {
    ...(packetName === 'title' ? { action: 1 } : {}),
    text: JSON.stringify({ text: 'Split with your teamate.', color: 'yellow' })
  }
}

function splitTitleSubtitlePacketName(packetName: string): string | null {
  if (packetName === 'title') return 'title'
  if (packetName === 'set_title_text' || packetName === 'set_title_subtitle') return 'set_title_subtitle'
  return null
}

function writeSplitTitleTiming(downstream: ServerClient, packetName: string) {
  const timing = splitTitleTimingPacket(packetName)
  if (timing) downstream.write(packetName, timing)
}

function writeSplitTitleSubtitle(downstream: ServerClient, packetName: string) {
  const subtitlePacketName = splitTitleSubtitlePacketName(packetName)
  if (!subtitlePacketName) return

  const subtitle = splitTitleSubtitlePacket(subtitlePacketName)
  if (!subtitle) return

  downstream.write(subtitlePacketName, subtitle)
  setTimeout(() => {
    try {
      if ((downstream as any).state === 'play') downstream.write(subtitlePacketName, subtitle)
    } catch {}
  }, 75)
}

function forcedSplitTitlePacket(packetName: string, packet: any, settings: SplitReminderSettings): any | null {
  const text = JSON.stringify({ text: splitTitleText(settings), color: 'green' })

  if (packetName === 'title') {
    return {
      ...packet,
      action: 0,
      text
    }
  }

  if (packetName === 'set_title_text') {
    return {
      ...packet,
      text
    }
  }

  return null
}

function withSplitReminderUnknownPacket(
  packet: any,
  state: SplitReminderState,
  settings: SplitReminderSettings,
  now = Date.now()
): { packet: any; changed: boolean } {
  if (!settings.enabled || !state.splitPending) {
    return { packet, changed: false }
  }

  const rewritten = rewriteRespawnedPacketText(packet, settings)
  if (rewritten.changed) {
    state.splitPending = false
    state.respawning = false
    state.lastTrigger = ''
    state.preRespawnTrigger = ''
    state.preRespawnTriggerAt = 0
  }
  return { packet: rewritten.value, changed: rewritten.changed }
}

function nicknameForPlayer(name: unknown, nicknames: Map<string, string>): string | null {
  if (typeof name !== 'string') return null
  return nicknames.get(stripColors(name).toLowerCase()) || null
}

type LegacyComponentStyle = {
  color?: string
  bold?: boolean
  italic?: boolean
  underlined?: boolean
  strikethrough?: boolean
  obfuscated?: boolean
}

const LEGACY_COMPONENT_COLORS: Record<string, string> = {
  0: 'black',
  1: 'dark_blue',
  2: 'dark_green',
  3: 'dark_aqua',
  4: 'dark_red',
  5: 'dark_purple',
  6: 'gold',
  7: 'gray',
  8: 'dark_gray',
  9: 'blue',
  a: 'green',
  b: 'aqua',
  c: 'red',
  d: 'light_purple',
  e: 'yellow',
  f: 'white'
}

function legacyFormattedComponent(text: string): any {
  const runs: any[] = []
  let style: LegacyComponentStyle = {}
  let content = ''

  const flush = () => {
    if (!content) return
    runs.push({ text: content, ...style })
    content = ''
  }

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '\u00a7' || index + 1 >= text.length) {
      content += text[index]
      continue
    }

    const code = text[index + 1].toLowerCase()
    const colorName = LEGACY_COMPONENT_COLORS[code]
    if (colorName) {
      flush()
      style = { color: colorName }
      index += 1
      continue
    }

    const decoration: keyof LegacyComponentStyle | null = code === 'k'
      ? 'obfuscated'
      : code === 'l'
        ? 'bold'
        : code === 'm'
          ? 'strikethrough'
          : code === 'n'
            ? 'underlined'
            : code === 'o'
              ? 'italic'
              : null
    if (decoration) {
      flush()
      style = { ...style, [decoration]: true }
      index += 1
      continue
    }

    if (code === 'r') {
      flush()
      style = {}
      index += 1
      continue
    }

    content += text[index]
  }
  flush()

  if (!runs.length) return { text: '' }
  if (runs.length === 1) return runs[0]
  return { text: '', extra: runs }
}

function nicknameDisplayTeam(state: SessionState | undefined, playerName: string): TeamState | null {
  if (!state) return null
  const teams = Array.from(state.teams.values()).filter(team => teamHasPlayer(team, playerName))
  teams.sort((left, right) => {
    const leftFormatting = stripColors(`${left.prefix}${left.suffix}`).length
    const rightFormatting = stripColors(`${right.prefix}${right.suffix}`).length
    if (leftFormatting !== rightFormatting) return rightFormatting - leftFormatting
    if (left.players.size !== right.players.size) return left.players.size - right.players.size
    return left.team.localeCompare(right.team)
  })
  return teams[0] || null
}

function rewrittenPlayerDisplayComponent(player: any, nicknames: Map<string, string>): any | null {
  const original = typeof player?.displayName === 'string' ? player.displayName : null
  if (!original) return null

  try {
    const parsed = JSON.parse(original)
    const rewritten = replaceNamesInChat(parsed, nicknames)
    return JSON.stringify(rewritten) === JSON.stringify(parsed) ? null : rewritten
  } catch {
    const rewritten = replaceNames(original, nicknames)
    return rewritten === original ? null : legacyFormattedComponent(rewritten)
  }
}

function teamNicknameComponent(player: any, nickname: string, state?: SessionState): any | null {
  if (typeof player?.name !== 'string') return null
  const team = nicknameDisplayTeam(state, player.name)
  if (!team) return null
  return legacyFormattedComponent(`${team.prefix}${nickname}${team.suffix}`)
}

function localPlayerDisplayComponent(player: any, nicknames: Map<string, string>, state?: SessionState): any | null {
  const nickname = nicknameForPlayer(player?.name, nicknames)
  if (!nickname) return null
  return rewrittenPlayerDisplayComponent(player, nicknames)
    || teamNicknameComponent(player, nickname, state)
    || { text: nickname }
}

function localPlayerNametagComponent(player: any, nicknames: Map<string, string>, state?: SessionState): any | null {
  const nickname = nicknameForPlayer(player?.name, nicknames)
  if (!nickname) return null
  return teamNicknameComponent(player, nickname, state)
    || rewrittenPlayerDisplayComponent(player, nicknames)
    || { text: nickname }
}

function localPlayerDisplayName(player: any, nicknames: Map<string, string>, state?: SessionState): string | null {
  const original = typeof player?.displayName === 'string' ? player.displayName : null
  const component = localPlayerDisplayComponent(player, nicknames, state)
  if (!component) return original

  return JSON.stringify(component)
}

function isAction(action: unknown, text: string, id: number): boolean {
  return action === text || action === id
}

function playerInfoMayChangeBedWarsRoster(packet: any): boolean {
  return isAction(packet?.action, 'add_player', 0)
    || isAction(packet?.action, 'update_display_name', 3)
    || isAction(packet?.action, 'remove_player', 4)
}

function shouldExtendTransferWatchFromChunk(
  splitState: SplitReminderState,
  transferWatch: TransferWatchState
): boolean {
  return !splitState.bedWarsGameActive || transferWatch.active
}

function playerInfoProfile(player: any, state?: SessionState): any | null {
  if (typeof player?.name === 'string') return player
  if (!state) return null
  const key = state.playerNameByUuid.get(uuidKey(player?.uuid))
  return key ? state.playersByName.get(key) || null : null
}

function withNicknamePlayerInfo(packet: any, nicknames: Map<string, string>, state?: SessionState): any {
  const players = Array.isArray(packet?.data) ? packet.data : null
  if (!players) return packet

  const addPlayer = isAction(packet.action, 'add_player', 0)
  const updatesDisplayName = addPlayer || isAction(packet.action, 'update_display_name', 3)
  if (!updatesDisplayName) return packet

  let changed = false
  const nextPlayers = players.map((player: any) => {
    const profile = playerInfoProfile(player, state)
    if (!profile) return player

    const displayName = localPlayerDisplayName(profile, nicknames, state)
    const packetDisplayName = typeof player?.displayName === 'string' ? player.displayName : null
    if (displayName === packetDisplayName) return player

    changed = true
    return { ...player, displayName }
  })

  if (!changed) return packet
  return { ...packet, data: nextPlayers }
}

function withNicknameScoreboardTeam(packet: any, nicknames: Map<string, string>): any {
  return packet
}

function withNicknameScoreboardScore(packet: any, nicknames: Map<string, string>): any {
  return packet
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

  team.sentPlayers = new Set(team.players)
}

function teamColorName(team: TeamState): string | null {
  const tabTeam = bedWarsTabTeamName(team)
  if (tabTeam) return tabTeam

  const text = `${team.team} ${team.prefix} ${team.suffix}`
  const legacy = legacyColorName(text)
  if (legacy) return legacy

  const named = /\b(red|blue|green|yellow|aqua|white|pink|gray|grey)\b/i.exec(stripColors(text))
  if (!named) return null
  return named[1].toLowerCase() === 'grey'
    ? 'Gray'
    : named[1][0].toUpperCase() + named[1].slice(1).toLowerCase()
}

function teamDisplayName(team: TeamState): string {
  return teamColorName(team) || stripColors(team.team).trim() || team.team
}

function localTeammateNames(
  state: SessionState,
  localPlayerName: string,
  splitState?: SplitReminderState,
  now = Date.now()
): string[] {
  const snapshot = localPlayerTeamSnapshot(state, localPlayerName, splitState, now)
  return snapshot ? localTeamPlayerNames(snapshot) : []
}

function logLocalTeamIfChanged(state: SessionState, localPlayerName: string, splitState: SplitReminderState, now = Date.now()) {
  const snapshot = localPlayerTeamSnapshot(state, localPlayerName, splitState, now)
  if (!snapshot) return

  const players = localTeamPlayerNames(snapshot)
  const signature = `${currentSnapshotTeamKey(snapshot)}\u0000${players.join('\u0000')}`
  if (signature === splitState.lastTeamSignature) return

  splitState.lastTeamSignature = signature
  term('QoL', `Team detected: ${snapshot.colorName || teamDisplayName(snapshot.primaryTeam)} (${players.join(', ')})`, colors.yellow)
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

function scoreboardLinesForItem(itemName: string, state: SessionState): string[] {
  const lines = [itemName]

  for (const team of state.teams.values()) {
    if (!teamHasPlayer(team, itemName)) continue
    lines.push(`${team.prefix || ''}${itemName}${team.suffix || ''}`)
    lines.push(`${team.prefix || ''}${team.suffix || ''}`)
  }

  return Array.from(new Set(lines))
}

function scoreboardModeTexts(state: SessionState): string[] {
  const lines: string[] = []

  for (const score of state.scores.values()) {
    if (typeof score?.itemName !== 'string') continue
    lines.push(...scoreboardLinesForItem(score.itemName, state))
  }

  for (const team of state.teams.values()) {
    lines.push(`${team.team} ${team.prefix || ''} ${team.suffix || ''}`)
  }

  return Array.from(new Set(lines))
}

function updateBedWarsModeFromScoreboard(
  state: SessionState,
  splitState: SplitReminderState
): { label: string; maxPlayers: number } | null {
  let detected: { label: string; maxPlayers: number } | null = null

  for (const text of scoreboardModeTexts(state)) {
    const result = applyBedWarsTeamModeFromText(text, splitState)
    if (result) detected = result
  }

  return detected || applyBedWarsTeamModeFromScoreboardGroups(state, splitState)
}

function logBedWarsModeIfChanged(splitState: SplitReminderState, mode: { label: string; maxPlayers: number } | null) {
  if (!mode) return
  const signature = `${mode.label}:${mode.maxPlayers}`
  if (splitState.lastModeLogSignature === signature) return
  splitState.lastModeLogSignature = signature
  term('QoL', `Mode detected: ${mode.label} (team cap ${mode.maxPlayers}).`, colors.yellow)
}

function writeApolloJson(downstream: ServerClient, message: Record<string, unknown>): boolean {
  try {
    downstream.write('custom_payload', apolloJsonPacket(message))
    return true
  } catch {
    return false
  }
}

function refreshNicknameTabPlayers(
  downstream: ServerClient,
  state: SessionState,
  nicknames: Map<string, string>,
  playerNames: Iterable<string>
) {
  const refreshed = new Set<string>()
  for (const playerName of playerNames) {
    const key = playerKey(playerName)
    if (!key || refreshed.has(key)) continue
    refreshed.add(key)

    const player = state.playersByName.get(key)
    if (!player || !nicknameForPlayer(player.name, nicknames)) continue
    try {
      downstream.write('player_info', {
        action: 'update_display_name',
        data: [{
          uuid: player.uuid,
          displayName: localPlayerDisplayName(player, nicknames, state)
        }]
      })
    } catch {}
  }
}

function refreshApolloNametags(
  downstream: ServerClient,
  state: SessionState,
  nicknames: Map<string, string>,
  playerName?: string,
  resetAll = false
) {
  if (resetAll) writeApolloJson(downstream, resetAllApolloNametagsMessage())
  const targetKey = playerName ? playerKey(playerName) : ''

  for (const player of state.playersByName.values()) {
    if (targetKey && playerKey(player?.name || '') !== targetKey) continue
    const component = localPlayerNametagComponent(player, nicknames, state)
    if (!component) {
      if (targetKey) writeApolloJson(downstream, resetApolloNametagMessage(player.uuid))
      continue
    }
    writeApolloJson(downstream, overrideApolloNametagMessage(player.uuid, component))
  }
}

function refreshLocalNicknames(
  downstream: ServerClient,
  state: SessionState,
  nicknames: Map<string, string>,
  playerName?: string
) {
  const targetKey = playerName ? playerKey(playerName) : ''

  for (const player of state.playersByName.values()) {
    if (targetKey && playerKey(player?.name || '') !== targetKey) continue
    try {
      downstream.write('player_info', {
        action: 'update_display_name',
        data: [{
          uuid: player.uuid,
          displayName: localPlayerDisplayName(player, nicknames, state)
        }]
      })
    } catch {}
  }

  for (const entity of state.playerEntitiesByUuid.values()) {
    const entityPlayerKey = state.playerNameByUuid.get(entity.uuid) || ''
    if (targetKey && entityPlayerKey !== targetKey) continue
    try {
      downstream.write('entity_metadata', {
        entityId: entity.entityId,
        metadata: withNicknameMetadata(entity.metadata, nicknames)
      })
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

function showMicrosoftCode(player: string, data: MsaCode) {
  const prompt = microsoftAuthPrompt(player, data)

  console.log('')
  logMicrosoftAuth(player, prompt.url, prompt.code)
  term('Microsoft', `Please go to ${color(prompt.url, colors.cyan)} and enter the code ${color(prompt.code, colors.yellow)}.`, colors.cyan)
  console.log(`URL: ${prompt.url}`)
  console.log(`Code: ${prompt.code}`)
  console.log(`Then sign into the Microsoft account you use for ${color(player, colors.cyan)}.`)
  console.log('')
}

function parseNicknameCommand(message: string): { player: string; nickname: string } | null {
  const match = /^\s*\/nickname\s+([A-Za-z0-9_]{1,16})\s+(.+?)\s*$/.exec(message)
  if (!match) return null

  let nickname = match[2].trim()
  const quoted = /^"([^"]+)"$/.exec(nickname)
  if (quoted) nickname = quoted[1].trim()

  return { player: match[1], nickname }
}

const LOBBY_COMMAND_ALIASES: Record<string, string> = {
  '/arcade': 'arcade',
  '/bb': 'buildbattle',
  '/bedwars': 'bedwars',
  '/blitz': 'blitz',
  '/buildbattle': 'buildbattle',
  '/bw': 'bedwars',
  '/cac': 'copsandcrims',
  '/classic': 'classic',
  '/copsandcrims': 'copsandcrims',
  '/duels': 'duels',
  '/housing': 'housing',
  '/main': 'main',
  '/megawalls': 'megawalls',
  '/mm': 'murdermystery',
  '/murdermystery': 'murdermystery',
  '/pit': 'pit',
  '/prototype': 'prototype',
  '/quake': 'quake',
  '/skywars': 'skywars',
  '/smash': 'smash',
  '/speeduhc': 'speeduhc',
  '/sw': 'skywars',
  '/tntgames': 'tntgames',
  '/uhc': 'uhc',
  '/vampirez': 'vampirez',
  '/warlords': 'warlords',
  '/walls': 'walls'
}

const LOBBY_GUI_CLICK_DEDUPE_MS = 1200

function cleanWindowTitle(title: unknown): string {
  return stripColors(flattenChatToText(title)).trim().replace(/\s+/g, ' ')
}

function isLobbySelectorWindowTitle(title: unknown): boolean {
  const clean = cleanWindowTitle(title).toLowerCase()
  return /\bgame menu\b/.test(clean)
    || /\blobby selector\b/.test(clean)
    || /\bserver selector\b/.test(clean)
    || /\bplay games\b/.test(clean)
    || /\bquick join\b/.test(clean)
}

function lobbyWindowClickKey(data: any): string {
  const windowId = Number(data?.windowId ?? data?.id ?? -1)
  const slot = Number(data?.slot ?? -1)
  const mouseButton = Number(data?.mouseButton ?? data?.button ?? -1)
  const mode = Number(data?.mode ?? -1)
  return `${windowId}:${slot}:${mouseButton}:${mode}`
}

function serverListDescription(route: UpstreamRoute): any {
  const routeColor = serverListRouteColor(route)
  const ping = upstreamPingText(null)
  return {
    text: '',
    extra: [
      { text: '                           ' },
      { text: 'Hypixel Proxy', color: 'gold', bold: true },
      { text: '\n' },
      { text: serverListRoutePadding(route) },
      { text: 'Route: ', color: 'gray' },
      { text: route.name, color: routeColor },
      { text: ' -> Hypixel', color: 'dark_gray' },
      { text: '  Ping: ', color: 'gray' },
      { text: ping, color: upstreamPingColor(null) }
    ]
  }
}

function upstreamPingText(latency: number | null): string {
  return latency == null ? 'checking...' : `${latency}ms`
}

function upstreamPingColor(latency: number | null): string {
  if (latency == null) return 'dark_gray'
  if (latency < 100) return 'green'
  if (latency < 170) return 'yellow'
  return 'red'
}

function serverListRoutePadding(route: UpstreamRoute): string {
  if (route.id === 'direct') return '                 '
  if (route.id === 'hypixelfast') return '           '
  return '            '
}

function serverListRouteColor(route: UpstreamRoute): string {
  if (route.id === 'stopthelag') return 'aqua'
  if (route.id === 'hypixelfast') return 'yellow'
  return 'green'
}

function serverListDescriptionWithPing(route: UpstreamRoute, latency: number | null): any {
  const routeColor = serverListRouteColor(route)
  return {
    text: '',
    extra: [
      { text: '                           ' },
      { text: 'Hypixel Proxy', color: 'gold', bold: true },
      { text: '\n' },
      { text: serverListRoutePadding(route) },
      { text: route.name, color: routeColor },
      { text: ' -> Hypixel', color: 'dark_gray' },
      { text: '  Ping: ', color: 'gray' },
      { text: upstreamPingText(latency), color: upstreamPingColor(latency) }
    ]
  }
}

function serverListLegacyMotd(route: UpstreamRoute, latency: number | null = null): string {
  return `Hypixel Proxy | ${route.name} -> Hypixel | Ping: ${upstreamPingText(latency)}`
}

function serverListPlayers(route: UpstreamRoute, sessions = activeSessions, latency: number | null = null): any {
  const online = Math.max(0, sessions)
  return {
    max: Math.max(1, online),
    online,
    sample: [
      { id: '00000000-0000-0000-0000-000000000001', name: `Route: ${route.name}` },
      { id: '00000000-0000-0000-0000-000000000003', name: `Proxy -> Hypixel ping: ${upstreamPingText(latency)}` },
      { id: '00000000-0000-0000-0000-000000000002', name: `Local: ${LOCAL_ADDRESS}` }
    ]
  }
}

function serverListStatusResponse(
  route: UpstreamRoute,
  upstreamPong: any = null,
  clientProtocol = 47,
  upstreamLatency: number | null = typeof upstreamPong?.latency === 'number' ? Math.round(upstreamPong.latency) : null
): any {
  return {
    version: upstreamPong?.version ?? { name: VERSION, protocol: clientProtocol },
    players: serverListPlayers(route, activeSessions, upstreamLatency),
    description: serverListDescriptionWithPing(route, upstreamLatency),
    favicon: serverIcon
  }
}

async function getUpstreamStatus(route: UpstreamRoute, now = Date.now()): Promise<UpstreamStatusSnapshot> {
  if (upstreamStatusCache && upstreamStatusCache.routeId === route.id && now - upstreamStatusCache.checkedAt < SERVER_LIST_PING_CACHE_MS) {
    return upstreamStatusCache
  }

  if (!upstreamStatusInFlight) {
    upstreamStatusInFlight = (async () => {
      try {
        const pong: any = await mc.ping({
          host: route.host,
          port: route.port,
          version: VERSION,
          closeTimeout: SERVER_LIST_PING_TIMEOUT_MS,
          noPongTimeout: SERVER_LIST_PING_TIMEOUT_MS
        } as any)
        return {
          routeId: route.id,
          checkedAt: Date.now(),
          latency: typeof pong?.latency === 'number' ? Math.round(pong.latency) : null,
          pong
        }
      } catch {
        return {
          routeId: route.id,
          checkedAt: Date.now(),
          latency: null,
          pong: null
        }
      }
    })().finally(() => {
      upstreamStatusInFlight = null
    })
  }

  upstreamStatusCache = await upstreamStatusInFlight
  return upstreamStatusCache
}

function lobbyCommandKey(message: string): string | null {
  const clean = stripColors(message).trim().replace(/\s+/g, ' ').toLowerCase()
  const [command = '', firstArg = ''] = clean.split(' ')

  if (command === '/l' || command === '/leave' || command === '/hub') return 'lobby'
  if (command === '/lobby') return firstArg ? `lobby:${firstArg}` : 'lobby'

  const alias = LOBBY_COMMAND_ALIASES[command]
  if (alias) return `lobby:${alias}`

  return null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function shouldRawForwardUpstreamPacket(packetName: string): boolean {
  return RAW_FORWARD_UPSTREAM_PACKETS.has(packetName)
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

function bridgePlay(
  upstream: Client,
  downstream: ServerClient,
  nicknames: Map<string, string>,
  sessionState: SessionState,
  splitReminderState: SplitReminderState
) {
  let lastLobbyCommandKey = ''
  let lastLobbyCommandAt = 0
  let currentWindowId = -1
  let currentWindowTitle = ''
  let currentWindowIsLobbySelector = false
  let lastLobbyWindowClickKey = ''
  let lastLobbyWindowClickAt = 0
  let lastScoreboardAnalysisAt = 0
  let scoreboardAnalysisDeferred = false
  const transferWatch: TransferWatchState = {
    active: false,
    expiresAt: 0
  }
  const apolloNickname = {
    supported: false,
    channelAnnounced: false,
    configured: false,
    clientJoinedWorld: false
  }

  const configureApolloNicknames = () => {
    if (!apolloNickname.supported || !apolloNickname.channelAnnounced || apolloNickname.configured) return
    if (!writeApolloJson(downstream, enableApolloNametagMessage())) return
    refreshApolloNametags(downstream, sessionState, nicknames, undefined, true)
    apolloNickname.configured = true
    term('Nick', 'Lunar nametag support enabled.', colors.green)
  }

  const announceApolloJsonChannel = () => {
    if (apolloNickname.channelAnnounced || !apolloNickname.clientJoinedWorld || downstream.state !== 'play') return
    try {
      downstream.write('custom_payload', apolloChannelRegistrationPacket())
      apolloNickname.channelAnnounced = true
      configureApolloNicknames()
    } catch {}
  }

  const activateApolloNicknames = () => {
    if (apolloNickname.supported) return
    apolloNickname.supported = true
    announceApolloJsonChannel()
    configureApolloNicknames()
  }

  const refreshApolloPlayers = (playerNames: Iterable<string>) => {
    if (!apolloNickname.configured) return
    const refreshed = new Set<string>()
    for (const playerName of playerNames) {
      const key = playerKey(playerName)
      if (!key || refreshed.has(key)) continue
      refreshed.add(key)
      refreshApolloNametags(downstream, sessionState, nicknames, playerName)
    }
  }

  downstream.on('state', state => {
    if (state === 'play') announceApolloJsonChannel()
  })
  announceApolloJsonChannel()

  const startTransferWatch = () => {
    transferWatch.active = true
    transferWatch.expiresAt = Date.now() + TRANSFER_WATCH_MS
  }

  const isTransferActive = () => {
    const now = Date.now()
    if (transferWatch.active && now > transferWatch.expiresAt) {
      transferWatch.active = false
    }
    return transferWatch.active
  }

  const analyzeScoreboard = (force = false) => {
    if (!appConfig.splitReminder.enabled) return
    if (isTransferActive()) {
      scoreboardAnalysisDeferred = true
      return
    }

    const now = Date.now()
    if (!force && !scoreboardAnalysisDeferred && now - lastScoreboardAnalysisAt < SCOREBOARD_ANALYSIS_THROTTLE_MS) return
    lastScoreboardAnalysisAt = now

    scoreboardAnalysisDeferred = false
    const mode = updateBedWarsModeFromScoreboard(sessionState, splitReminderState)
    logBedWarsModeIfChanged(splitReminderState, mode)
    logLocalTeamIfChanged(sessionState, downstream.username, splitReminderState)
  }

  const analyzeTeamAfterGameStart = (previousGameStartedAt: number) => {
    if (!splitReminderState.bedWarsGameActive) return
    if (splitReminderState.bedWarsGameStartedAt === previousGameStartedAt) return

    // The transfer guard should not hide the new match roster for 20 seconds.
    transferWatch.active = false
    analyzeScoreboard(true)
  }

  upstream.on('raw', (buffer: Buffer, meta: any) => {
    if (upstream.state !== 'play' || downstream.state !== 'play') return
    const packetName = String(meta?.name || '')
    if (!shouldRawForwardUpstreamPacket(packetName)) return

    try {
      downstream.writeRaw(buffer)
      if (shouldExtendTransferWatchFromChunk(splitReminderState, transferWatch)) {
        startTransferWatch()
      }
    } catch (error) {
      term('Bridge', `Dropped raw upstream packet ${String(meta?.name || 'unknown')}: ${errorMessage(error)}`, colors.red)
    }
  })

  upstream.on('packet', (data, meta) => {
    if (upstream.state !== 'play' || downstream.state !== 'play') return
    if (shouldRawForwardUpstreamPacket(meta.name)) return

    try {
      if (meta.name === 'login' || meta.name === 'respawn') {
        startTransferWatch()
      }
      if (meta.name === 'chat') {
        const raw = (data as any).message
        const position = (data as any).position ?? 0
        const comp = (() => {
          try {
            return JSON.parse(raw)
          } catch {
            return raw
          }
        })()
        const now = Date.now()
        const gameStartedAtBeforeChat = splitReminderState.bedWarsGameStartedAt
        const pendingBeforeChat = splitReminderState.splitPending
        const splitSignalBeforeChat = splitReminderState.splitSignalId
        withSplitReminderChatComponent(
          comp,
          splitReminderState,
          appConfig.splitReminder,
          now,
          {
            sessionState,
            localPlayerName: downstream.username,
            log: message => term('QoL', message, colors.yellow)
          }
        )
        analyzeTeamAfterGameStart(gameStartedAtBeforeChat)
        if (splitReminderState.splitPending && splitReminderState.splitSignalId !== splitSignalBeforeChat) {
          splitSoundEventId += 1
        }
        const withNicknames = replaceNamesInChat(comp, nicknames)
        if (!pendingBeforeChat && splitReminderState.splitPending) {
          term('QoL', `Split armed by ${splitReminderState.lastTrigger}.`, colors.yellow)
        }

        const pendingBeforeOverlay = splitReminderState.splitPending
        const trigger = splitReminderState.lastTrigger
        const withSplitReminder = position === 2
          ? withSplitReminderTitleComponent(withNicknames, splitReminderState, appConfig.splitReminder, now)
          : withNicknames
        if (position === 2 && pendingBeforeOverlay && JSON.stringify(withSplitReminder) !== JSON.stringify(withNicknames)) {
          term('QoL', `Split title shown from ${trigger || 'teammate death'}.`, colors.yellow)
        } else if (pendingBeforeOverlay) {
          const snippets = respawnedPacketSnippets(withNicknames, appConfig.splitReminder)
          if (snippets.length) {
            term('QoL', `Saw respawn text in chat position ${position}: ${snippets[0]}.`, colors.yellow)
          }
        }

        downstream.write('chat', {
          ...data,
          message: JSON.stringify(withSplitReminder),
          position
        })
        return
      }

      if (meta.name === 'title' || meta.name === 'set_title_text' || meta.name === 'set_title_subtitle' || meta.name === 'set_action_bar_text') {
        const gameStartedAtBeforeTitle = splitReminderState.bedWarsGameStartedAt
        const pendingBeforeTitle = splitReminderState.splitPending
        const trigger = splitReminderState.lastTrigger
        const updated = withSplitReminderPacket(
          meta.name,
          data,
          splitReminderState,
          appConfig.splitReminder,
          Date.now(),
          sessionState,
          downstream.username
        )
        analyzeTeamAfterGameStart(gameStartedAtBeforeTitle)
        if (pendingBeforeTitle && JSON.stringify(updated) !== JSON.stringify(data)) {
          term('QoL', `Split title shown from ${trigger || 'teammate death'}.`, colors.yellow)
          writeSplitTitleTiming(downstream, meta.name)
          downstream.write(meta.name, updated)
          writeSplitTitleSubtitle(downstream, meta.name)
          return
        } else if (pendingBeforeTitle && packetHasRespawnedTitleText(data, appConfig.splitReminder)) {
          const forced = forcedSplitTitlePacket(meta.name, data, appConfig.splitReminder)
          if (forced !== null) {
            splitReminderState.splitPending = false
            splitReminderState.respawning = false
            splitReminderState.lastTrigger = ''
            splitReminderState.preRespawnTrigger = ''
            splitReminderState.preRespawnTriggerAt = 0
            term('QoL', `Split title forced from ${trigger || 'teammate death'} via ${meta.name}.`, colors.yellow)
            writeSplitTitleTiming(downstream, meta.name)
            downstream.write(meta.name, forced)
            writeSplitTitleSubtitle(downstream, meta.name)
            return
          }
        } else if (pendingBeforeTitle) {
          const snippets = respawnedPacketSnippets(data, appConfig.splitReminder)
          if (snippets.length) {
            term('QoL', `Saw respawn text in ${meta.name}: ${snippets[0]}.`, colors.yellow)
          }
        }
        downstream.write(meta.name, updated)
        return
      }

      if (meta.name === 'open_window') {
        currentWindowId = Number((data as any).windowId ?? (data as any).id ?? -1)
        currentWindowTitle = cleanWindowTitle((data as any).windowTitle ?? (data as any).title ?? '')
        currentWindowIsLobbySelector = isLobbySelectorWindowTitle(currentWindowTitle)
        downstream.write(meta.name, data)
        return
      }

      if (meta.name === 'close_window') {
        const windowId = Number((data as any).windowId ?? (data as any).id ?? -1)
        if (windowId === currentWindowId || windowId === -1) {
          currentWindowId = -1
          currentWindowTitle = ''
          currentWindowIsLobbySelector = false
          lastLobbyWindowClickKey = ''
          lastLobbyWindowClickAt = 0
        }
        downstream.write(meta.name, data)
        return
      }

      if (meta.name === 'player_info') {
        const rosterMayHaveChanged = playerInfoMayChangeBedWarsRoster(data)
        trackPlayerInfo(data, sessionState)
        if (rosterMayHaveChanged) analyzeScoreboard(true)
        downstream.write(meta.name, withNicknamePlayerInfo(data, nicknames, sessionState))
        const playerNames = (Array.isArray((data as any)?.data) ? (data as any).data : [])
          .map((player: any) => playerInfoProfile(player, sessionState)?.name)
          .filter((name: unknown): name is string => typeof name === 'string')
        refreshApolloPlayers(playerNames)
        return
      }

      if (meta.name === 'scoreboard_team' || meta.name === 'teams') {
        const previousPlayers = typeof (data as any)?.team === 'string'
          ? Array.from(sessionState.teams.get((data as any).team)?.players || [])
          : []
        trackScoreboardTeam(meta.name, data, sessionState, nicknames)
        analyzeScoreboard()
        downstream.write(meta.name, withNicknameScoreboardTeam(data, nicknames))
        const currentPlayers = typeof (data as any)?.team === 'string'
          ? Array.from(sessionState.teams.get((data as any).team)?.players || [])
          : []
        const affectedPlayers = [...previousPlayers, ...teamPlayers(data), ...currentPlayers]
        refreshNicknameTabPlayers(downstream, sessionState, nicknames, affectedPlayers)
        refreshApolloPlayers(affectedPlayers)
        return
      }

      if (meta.name === 'scoreboard_score') {
        trackScoreboardScore(data, sessionState)
        analyzeScoreboard()
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

      const pendingBeforeUnknown = splitReminderState.splitPending
      const trigger = splitReminderState.lastTrigger
      const rewritten = withSplitReminderUnknownPacket(data, splitReminderState, appConfig.splitReminder)
      if (pendingBeforeUnknown && rewritten.changed) {
        term('QoL', `Split title shown from ${trigger || 'teammate death'} via ${meta.name}.`, colors.yellow)
        writeSplitTitleTiming(downstream, meta.name)
        downstream.write(meta.name, rewritten.packet)
        writeSplitTitleSubtitle(downstream, meta.name)
        return
      } else if (pendingBeforeUnknown) {
        const snippets = respawnedPacketSnippets(data, appConfig.splitReminder)
        if (snippets.length) {
          term('QoL', `Saw respawn text in ${meta.name}: ${snippets[0]}.`, colors.yellow)
        }
      }

      downstream.write(meta.name, data)
      if (meta.name === 'login') {
        apolloNickname.clientJoinedWorld = true
        announceApolloJsonChannel()
      }
    } catch (error) {
      term('Bridge', `Dropped upstream packet ${meta.name}: ${errorMessage(error)}`, colors.red)
    }
  })

  downstream.on('packet', (data, meta) => {
    if (meta.name === 'custom_payload') {
      if (packetSignalsLunarClient(data)) {
        activateApolloNicknames()
      } else if (packetUnregistersApollo(data)) {
        apolloNickname.supported = false
        apolloNickname.configured = false
      }
    }

    if (downstream.state !== 'play' || upstream.state !== 'play') return

    if (meta.name === 'chat') {
      const message = String((data as any).message || '')

      if (/^\s*\/splitsound\s*$/i.test(message)) {
        splitSoundEventId += 1
        sendClientChat(downstream, { text: '[QoL] Split sound sent to the launcher.', color: 'yellow' })
        return
      }

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
          refreshLocalNicknames(downstream, sessionState, nicknames, clearMatch[1])
          if (apolloNickname.configured) {
            refreshApolloNametags(downstream, sessionState, nicknames, undefined, true)
          }
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
        refreshLocalNicknames(downstream, sessionState, nicknames, nickname.player)
        if (apolloNickname.configured) {
          refreshApolloNametags(downstream, sessionState, nicknames, nickname.player)
        }
        sendClientChat(downstream, okChat(`${nickname.player} visas lokalt som ${nickname.nickname}.`))
        return
      }

      if (/^\s*\/nickname\b/i.test(message)) {
        sendClientChat(downstream, infoChat('Usage: /nickname <player> "nickname"'))
        return
      }

      const commandKey = lobbyCommandKey(message)
      if (commandKey) {
        const now = Date.now()
        if (lastLobbyCommandKey === commandKey && now - lastLobbyCommandAt < LOBBY_COMMAND_DEDUPE_MS) {
          return
        }
        lastLobbyCommandKey = commandKey
        lastLobbyCommandAt = now
        startTransferWatch()
      }
    }

    if (meta.name === 'window_click') {
      const windowId = Number((data as any).windowId ?? (data as any).id ?? -1)
      const isCurrentLobbyWindow = currentWindowIsLobbySelector && windowId === currentWindowId
      if (isCurrentLobbyWindow) {
        const now = Date.now()
        const clickKey = lobbyWindowClickKey(data)
        if (lastLobbyWindowClickKey === clickKey && now - lastLobbyWindowClickAt < LOBBY_GUI_CLICK_DEDUPE_MS) {
          return
        }
        lastLobbyWindowClickKey = clickKey
        lastLobbyWindowClickAt = now
        startTransferWatch()
      }
    }

    try {
      upstream.write(meta.name, data)
    } catch (error) {
      term('Bridge', `Dropped downstream packet ${meta.name}: ${errorMessage(error)}`, colors.red)
    }
  })
}

export const __test = {
  createSplitReminderState,
  createSessionState,
  cleanWindowTitle,
  deathPlayerName,
  isLocalTeammateDeathText,
  isLobbySelectorWindowTitle,
  lobbyCommandKey,
  lobbyWindowClickKey,
  legacyFormattedComponent,
  localPlayerNametagComponent,
  localPlayerTeam,
  localTeammateNames,
  playerInfoMayChangeBedWarsRoster,
  shouldExtendTransferWatchFromChunk,
  refreshApolloNametags,
  refreshNicknameTabPlayers,
  refreshLocalNicknames,
  replaceNamesInChat,
  serverListDescription,
  serverListPlayers,
  serverListStatusResponse,
  trackNamedEntitySpawn,
  trackPlayerInfo,
  trackScoreboardTeam,
  trackScoreboardScore,
  updateBedWarsModeFromScoreboard,
  withSplitReminderChatComponent,
  withSplitReminderPacket,
  withSplitReminderUnknownPacket,
  forcedSplitTitlePacket,
  packetHasRespawnedTitleText,
  splitTitleSubtitlePacket,
  splitTitleTimingPacket,
  shouldRawForwardUpstreamPacket,
  withNicknameEntityMetadata,
  withNicknameNamedEntitySpawn,
  withNicknamePlayerInfo,
  withNicknameScoreboardScore,
  withNicknameScoreboardTeam
}

export function startProxy(): Server {
  appConfig = normalizeAppConfig(appConfig)
  const serverOpts: ServerOptions = {
    host: LISTEN_HOST,
    port: LISTEN_PORT,
    version: VERSION,
    motd: serverListLegacyMotd(currentRoute()),
    motdMsg: serverListDescription(currentRoute()),
    maxPlayers: 1,
    favicon: serverIcon,
    beforePing: (response: any, client: any, callback?: (error: unknown, result: any) => void) => {
      const route = currentRoute()
      getUpstreamStatus(route)
        .then(status => callback?.(null, serverListStatusResponse(route, status.pong || response, client?.protocolVersion ?? 47, status.latency)))
        .catch(() => callback?.(null, serverListStatusResponse(route, response, client?.protocolVersion ?? 47, null)))
    },
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

  let dashboardServer: ReturnType<typeof startDashboard>
  let shuttingDown = false
  const shutdown = (why = 'Shutdown requested') => {
    if (shuttingDown) return { ok: true, shuttingDown: true }
    shuttingDown = true
    term('Local', why, colors.magenta)
    setTimeout(() => {
      try {
        server.close()
      } catch {}
      try {
        dashboardServer.close()
      } catch {}
      process.exit(0)
    }, 100)
    return { ok: true, shuttingDown: true }
  }

  dashboardServer = startDashboard({
    host: DASHBOARD_HOST,
    port: DASHBOARD_PORT,
    getStatus: dashboardStatus,
    getSplitSoundStatus: splitSoundStatus,
    setRoute,
    setSplitReminderEnabled,
    shutdown: () => shutdown('Shutdown requested from app.')
  })
  dashboardServer.on('error', error => {
    console.error('[hypixel-proxy] dashboard error:', error)
  })

  server.on('login', (downstream: ServerClient) => {
    const clientSocket = (downstream as any).socket
    const remoteHost = clientSocket?.remoteAddress || 'localhost'
    const remotePort = clientSocket?.remotePort || LISTEN_PORT
    const route = currentRoute()
    activeSessions += 1
    let countedSession = true
    const closeSessionCounter = () => {
      if (!countedSession) return
      countedSession = false
      activeSessions = Math.max(0, activeSessions - 1)
    }
    term('Local', `${downstream.username} is logging in from ${remoteHost}:${remotePort} using Hypixel Proxy`, colors.magenta)
    term('Routing', `${downstream.username} -> ${route.name} (${route.host}:${route.port})`, colors.cyan)

    const nicknames = loadNicknames()
    const sessionState = createSessionState()
    const splitReminderState = createSplitReminderState()
    let microsoftCodeShown = false
    const upstream: Client = mc.createClient({
      host: route.host,
      port: route.port,
      version: VERSION,
      auth: 'microsoft',
      username: downstream.username,
      profilesFolder: AUTH_CACHE_DIR,
      onMsaCode: (data: MsaCode) => {
        microsoftCodeShown = true
        showMicrosoftCode(downstream.username, data)
        term('Microsoft', `Finish this sign-in first. If Minecraft disconnects, reconnect to ${LOCAL_ADDRESS} after Microsoft confirms the sign-in.`, colors.yellow)
      },
      keepAlive: true,
      hideErrors: true
    } as any)

    let localClosed = false
    let downstreamEnded = false
    let upstreamConnected = false
    let upstreamSessionReady = false
    let microsoftAuthCompleteLogged = false
    let detachedAuth = false

    const keepMicrosoftAuthRunning = (why: string) => {
      if (localClosed) return
      localClosed = true
      closeSessionCounter()
      detachedAuth = true
      logSessionClosed(`${why}; Microsoft sign-in is still running`)
      term('Microsoft', `Complete the browser sign-in, wait for confirmation here, then join ${LOCAL_ADDRESS} again.`, colors.yellow)
    }

    const closeBoth = (why: string) => {
      if (localClosed) return
      localClosed = true
      closeSessionCounter()
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
    bridgePlay(upstream, downstream, nicknames, sessionState, splitReminderState)

    upstream.on('session', () => {
      upstreamSessionReady = true
      const authenticatedUsername = upstream.username || downstream.username
      if (authenticatedUsername && playerKey(authenticatedUsername) !== playerKey(downstream.username)) {
        const removed = clearAuthCacheForUsername(downstream.username)
        const reason = microsoftAccountMismatchReason(downstream.username, authenticatedUsername)
        const cleared = removed
          ? ` Cleared ${removed} cached auth file(s) for ${downstream.username}.`
          : ` No cached auth files were found for ${downstream.username}.`
        term('Microsoft', `${reason}${cleared}`, colors.red)
        closeBoth(reason)
        return
      }

      if (microsoftCodeShown && !microsoftAuthCompleteLogged) {
        microsoftAuthCompleteLogged = true
        const username = authenticatedUsername
        const message = detachedAuth
          ? `Sign-in complete for ${username}. Reconnect in Minecraft using ${LOCAL_ADDRESS}.`
          : `Sign-in complete for ${username}.`
        termMicrosoftAuthComplete(username, message)
      }
    })

    upstream.on('connect', () => {
      upstreamConnected = true
      if (localClosed || detachedAuth || downstreamEnded) {
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
    shutdown('Shutting down...')
  })

  return server
}

if (require.main === module) {
  startProxy()
}
