import mc, { Client, Server, ServerClient, ServerOptions } from 'minecraft-protocol'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { AppConfig, RouteId, SplitReminderSettings, UpstreamRoute, createRouteCatalog, loadAppConfig, normalizeAppConfig, normalizeSplitReminderSettings, routeById, saveAppConfig } from './appConfig'
import { apolloChannelRegistrationPacket, apolloJsonPacket, enableApolloNametagMessage, overrideApolloNametagMessage, packetSignalsLunarClient, packetUnregistersApollo, resetAllApolloNametagsMessage, resetApolloNametagMessage } from './apollo'
import { startDashboard } from './dashboard'
import { MsaCode, microsoftAuthPrompt } from './microsoftAuthPrompt'
import {
  BlockedNameContext,
  BlockNickHistoryFile,
  createBlockNickHistoryState,
  observeBlockListChat,
  parseBlockListCommand,
  serializeBlockNickHistory,
  trackBlockListCommand
} from './state/blockNickHistory'
import {
  blockHitSoundPacket,
  createBlockHitSoundState,
  observeBlockHitEntityStatus,
  observeBlockHitHealth,
  releaseSwordBlock,
  resetBlockHitSoundState,
  trackBlockHitLocalEntity,
  trackBlockHitPosition,
  trackSwordBlock
} from './state/blockHitSoundState'
import {
  BedWarsTeamColor,
  ObsidianHolderDetection,
  createObsidianDetectorState,
  equipmentPacketHoldsObsidian,
  obsidianHolderDetections,
  rememberObsidianHolder,
  resetObsidianDetectorState
} from './state/obsidianDetectorState'
import {
  BedDefenseChunkPacket,
  bedDefenseBulkChunks,
  bedDefenseDetections,
  clearBedDefenseObsidian,
  createBedDefenseState,
  observeBedDefenseBlockChange,
  observeBedDefenseChunk,
  observeBedDefenseMultiBlockChange,
  resetBedDefenseState
} from './state/bedDefenseState'
import {
  SessionState,
  TeamState,
  clearSessionEntityHistory,
  createSessionState,
  pruneSessionHistory,
  scoreKey,
  sessionStateSizes,
  teamPlayers,
  trackEntityDestroy,
  trackEntityEquipment,
  trackEntityMetadata,
  trackEntityMovement,
  trackNamedEntitySpawn,
  trackLocalGameMode,
  trackPlayerInfo,
  trackScoreboardDisplayObjective,
  trackScoreboardObjective,
  trackScoreboardScore,
  trackScoreboardTeam,
  uuidKey
} from './state/sessionState'
import {
  SplitReminderState,
  createSplitReminderState,
  resetSplitReminderMatchState
} from './state/splitReminderState'
import {
  BEDWARS_RECONNECT_RESPAWN_MS,
  clearRespawnTimers,
  collectRespawnTimerUpdates,
  createRespawnTimerState,
  respawnTimerSeconds,
  startRespawnTimer
} from './state/respawnTimerState'
type NicknameFile = { nicknames: Record<string, string> }
type AppLogEntry = {
  time: string
  label: string
  message: string
  kind?: 'microsoft_auth' | 'microsoft_auth_complete'
  url?: string
  code?: string
  player?: string
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
type SettingCommand =
  | { action: 'list' }
  | { action: 'change'; path: string; value: boolean | null }
  | { action: 'help' }
type LocalSettingChange = {
  config: AppConfig
  path: string
  displayName: string
  oldValue: boolean
  newValue: boolean
}

loadDotEnv(path.join(process.cwd(), '.env'))

const VERSION = (process.env.MC_VERSION || '1.8.8') as any
const LISTEN_HOST = process.env.LISTEN_HOST || '127.0.0.1'
const LISTEN_PORT = Number(process.env.LISTEN_PORT || 25565)
const STATE_DIR = process.env.STATE_DIR || path.join(process.cwd(), 'state')
const NICKNAME_PATH = path.join(STATE_DIR, 'nicknames.json')
const BLOCK_NICK_HISTORY_PATH = path.join(STATE_DIR, 'block-nick-history.json')
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
const activeSessionStates = new Set<SessionState>()
const eventLoopLagSamples: number[] = []
let nextEventLoopCheckAt = Date.now() + 1000
const eventLoopDiagnosticsInterval = setInterval(() => {
  const now = Date.now()
  eventLoopLagSamples.push(Math.max(0, now - nextEventLoopCheckAt))
  if (eventLoopLagSamples.length > 60) eventLoopLagSamples.shift()
  nextEventLoopCheckAt = now + 1000
}, 1000)
eventLoopDiagnosticsInterval.unref?.()
let splitSoundEventId = 0
let blockHitSoundEventId = 0
let lastBlockHitSoundPollAt = 0
const activeBlockHitSoundTests = new Set<() => boolean>()
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
const BEDWARS_CHAT_TEAM_FORMAT: Record<string, { colorName: string; code: string; letter: string }> = {
  red: { colorName: 'Red', code: 'c', letter: 'R' },
  dark_red: { colorName: 'Red', code: 'c', letter: 'R' },
  blue: { colorName: 'Blue', code: '9', letter: 'B' },
  dark_blue: { colorName: 'Blue', code: '9', letter: 'B' },
  green: { colorName: 'Green', code: 'a', letter: 'G' },
  dark_green: { colorName: 'Green', code: 'a', letter: 'G' },
  yellow: { colorName: 'Yellow', code: 'e', letter: 'Y' },
  gold: { colorName: 'Yellow', code: 'e', letter: 'Y' },
  aqua: { colorName: 'Aqua', code: 'b', letter: 'A' },
  dark_aqua: { colorName: 'Aqua', code: 'b', letter: 'A' },
  white: { colorName: 'White', code: 'f', letter: 'W' },
  light_purple: { colorName: 'Pink', code: 'd', letter: 'P' },
  dark_purple: { colorName: 'Pink', code: 'd', letter: 'P' },
  gray: { colorName: 'Gray', code: '7', letter: 'S' },
  dark_gray: { colorName: 'Gray', code: '7', letter: 'S' }
}
const BEDWARS_LEGACY_CHAT_TEAM_FORMAT: Record<string, string> = {
  c: 'red',
  '4': 'dark_red',
  '9': 'blue',
  '1': 'dark_blue',
  a: 'green',
  '2': 'dark_green',
  e: 'yellow',
  '6': 'gold',
  b: 'aqua',
  '3': 'dark_aqua',
  f: 'white',
  d: 'light_purple',
  '5': 'dark_purple',
  '7': 'gray',
  '8': 'dark_gray'
}
const LOBBY_COMMAND_DEDUPE_MS = 2500
const RAW_FORWARD_UPSTREAM_PACKETS = new Set(['map_chunk', 'map_chunk_bulk'])
const BED_DEFENSE_SCAN_DELAY_MS = 50
const BED_DEFENSE_MAX_PENDING_CHUNKS = 96
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

function setBlockHitSoundEnabled(enabled: boolean) {
  updateAppConfig({
    ...appConfig,
    qol: {
      ...appConfig.qol,
      blockHitSoundEnabled: enabled
    }
  })
  term('QoL', `Blockhit sound ${enabled ? 'enabled' : 'disabled'}.`, colors.yellow)
  return dashboardStatus()
}

function setBlockHitSoundVolume(volume: number) {
  const nextVolume = Math.max(0, Math.min(100, Math.round(volume)))
  updateAppConfig({
    ...appConfig,
    qol: {
      ...appConfig.qol,
      blockHitSoundVolume: nextVolume
    }
  })
  term('QoL', `Blockhit sound volume set to ${nextVolume}%.`, colors.yellow)
  return dashboardStatus()
}

function testBlockHitSound() {
  let playedSessions = 0
  for (const playSound of activeBlockHitSoundTests) {
    if (playSound()) playedSessions += 1
  }
  return { ok: playedSessions > 0, playedSessions }
}

const LOCAL_SETTING_DEFINITIONS = [
  {
    path: 'bedwars.tablist.show_respawn_timer',
    aliases: ['respawn_timer', 'respawn-timer'],
    displayName: 'Show Respawn Timer'
  },
  {
    path: 'bedwars.obsidian_detector',
    aliases: ['obsidian_detector', 'obsidian-detector', 'obby'],
    displayName: 'Obsidian Detector'
  },
  {
    path: 'qol.split_reminder',
    aliases: ['split_reminder', 'split-reminder', 'split'],
    displayName: 'SPLIT Reminder'
  },
  {
    path: 'qol.blockhit_sound',
    aliases: ['blockhit_sound', 'blockhit-sound', 'blockhit'],
    displayName: 'Blockhit Sound'
  }
] as const

function parseSettingCommand(message: string): SettingCommand | null {
  const match = /^\s*\/setting(?:\s+(.*?))?\s*$/i.exec(message)
  if (!match) return null

  const args = (match[1] || '').trim()
  if (!args || /^(?:list|ls)$/i.test(args)) return { action: 'list' }
  if (/^(?:help|\?)$/i.test(args)) return { action: 'help' }

  const parts = args.split(/\s+/)
  if (parts.length > 2) return { action: 'help' }
  if (parts.length === 1) return { action: 'change', path: parts[0], value: null }

  const value = parts[1].toLowerCase()
  if (['on', 'enabled', 'enable', 'true'].includes(value)) {
    return { action: 'change', path: parts[0], value: true }
  }
  if (['off', 'disabled', 'disable', 'false'].includes(value)) {
    return { action: 'change', path: parts[0], value: false }
  }
  return { action: 'help' }
}

function canonicalSettingPath(pathValue: string): string | null {
  const pathKey = pathValue.trim().toLowerCase()
  const definition = LOCAL_SETTING_DEFINITIONS.find(setting => (
    setting.path === pathKey || setting.aliases.some(alias => alias === pathKey)
  ))
  return definition?.path || null
}

function localSettingValue(config: AppConfig, pathValue: string): boolean | null {
  const settingPath = canonicalSettingPath(pathValue)
  if (settingPath === 'bedwars.tablist.show_respawn_timer') {
    return config.bedWars.respawnTimerEnabled
  }
  if (settingPath === 'bedwars.obsidian_detector') {
    return config.bedWars.obsidianDetectorEnabled
  }
  if (settingPath === 'qol.split_reminder') {
    return config.splitReminder.enabled
  }
  if (settingPath === 'qol.blockhit_sound') {
    return config.qol.blockHitSoundEnabled
  }
  return null
}

function changeLocalSetting(
  config: AppConfig,
  pathValue: string,
  requestedValue: boolean | null
): LocalSettingChange | null {
  const settingPath = canonicalSettingPath(pathValue)
  if (!settingPath) return null
  const definition = LOCAL_SETTING_DEFINITIONS.find(setting => setting.path === settingPath)
  const oldValue = localSettingValue(config, settingPath)
  if (!definition || oldValue === null) return null
  const newValue = requestedValue === null ? !oldValue : requestedValue

  let nextConfig: AppConfig
  if (settingPath === 'bedwars.tablist.show_respawn_timer') {
    nextConfig = {
      ...config,
      bedWars: {
        ...config.bedWars,
        respawnTimerEnabled: newValue
      }
    }
  } else if (settingPath === 'bedwars.obsidian_detector') {
    nextConfig = {
      ...config,
      bedWars: {
        ...config.bedWars,
        obsidianDetectorEnabled: newValue
      }
    }
  } else if (settingPath === 'qol.split_reminder') {
    nextConfig = {
      ...config,
      splitReminder: {
        ...config.splitReminder,
        enabled: newValue
      }
    }
  } else {
    nextConfig = {
      ...config,
      qol: {
        ...config.qol,
        blockHitSoundEnabled: newValue
      }
    }
  }

  return {
    config: normalizeAppConfig(nextConfig),
    path: settingPath,
    displayName: definition.displayName,
    oldValue,
    newValue
  }
}

function dashboardStatus() {
  const route = currentRoute()
  const memory = process.memoryUsage()
  const stateTotals = {
    activePlayers: 0,
    knownPlayers: 0,
    playerUuidMappings: 0,
    localAliases: 0,
    teams: 0,
    knownPlayerTeams: 0,
    knownTeamMemberships: 0,
    playerEntities: 0,
    entityIds: 0,
    scores: 0,
    displayedObjectives: 0
  }
  for (const state of activeSessionStates) {
    const sizes = sessionStateSizes(state)
    for (const key of Object.keys(stateTotals) as Array<keyof typeof stateTotals>) {
      stateTotals[key] += sizes[key]
    }
  }
  const lagTotal = eventLoopLagSamples.reduce((total, lag) => total + lag, 0)
  return {
    version: VERSION_LABEL,
    localAddress: LOCAL_ADDRESS,
    dashboardAddress: DASHBOARD_ADDRESS,
    activeSessions,
    route,
    routes: ROUTES,
    bedWars: appConfig.bedWars,
    qol: appConfig.qol,
    splitReminder: appConfig.splitReminder,
    diagnostics: {
      process: {
        uptimeSeconds: Math.round(process.uptime()),
        rssMb: Math.round(memory.rss / 1024 / 1024 * 10) / 10,
        heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024 * 10) / 10,
        externalMb: Math.round(memory.external / 1024 / 1024 * 10) / 10
      },
      eventLoop: {
        currentMs: eventLoopLagSamples[eventLoopLagSamples.length - 1] || 0,
        averageMs: eventLoopLagSamples.length
          ? Math.round(lagTotal / eventLoopLagSamples.length * 10) / 10
          : 0,
        maxMs: eventLoopLagSamples.length ? Math.max(...eventLoopLagSamples) : 0,
        samples: eventLoopLagSamples.length
      },
      state: stateTotals
    },
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

function loadBlockNickHistory() {
  ensureStateDir()
  if (!fs.existsSync(BLOCK_NICK_HISTORY_PATH)) return createBlockNickHistoryState()

  try {
    const parsed = JSON.parse(fs.readFileSync(BLOCK_NICK_HISTORY_PATH, 'utf8')) as BlockNickHistoryFile
    return createBlockNickHistoryState(parsed)
  } catch (error) {
    term('Config', `Could not read block-nick-history.json; starting with an empty history: ${String(error)}`, colors.yellow)
    return createBlockNickHistoryState()
  }
}

function saveBlockNickHistory(state: ReturnType<typeof createBlockNickHistoryState>) {
  ensureStateDir()
  const tmp = BLOCK_NICK_HISTORY_PATH + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(serializeBlockNickHistory(state), null, 2))
  fs.renameSync(tmp, BLOCK_NICK_HISTORY_PATH)
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

function localRespawnCountdownSeconds(text: string): number | null {
  const match = /\byou will respawn in (\d+) seconds?[.!]?$/i.exec(stripColors(text).trim())
  if (!match) return null
  const seconds = Number(match[1])
  return Number.isInteger(seconds) && seconds > 0 ? seconds : null
}

function isLocalDeathTitleText(text: string): boolean {
  return /^\s*YOU DIED[.!]?\s*$/i.test(stripColors(text))
}

function packetHasLocalDeathTitleText(value: any): boolean {
  if (value == null) return false
  if (typeof value === 'string') {
    if (isLocalDeathTitleText(value)) return true
    try {
      return packetHasLocalDeathTitleText(JSON.parse(value))
    } catch {
      return false
    }
  }
  if (Array.isArray(value)) {
    if (isLocalDeathTitleText(flattenChatToText(value))) return true
    return value.some(packetHasLocalDeathTitleText)
  }
  if (typeof value === 'object') {
    if (isLocalDeathTitleText(flattenChatToText(value))) return true
    return Object.values(value).some(packetHasLocalDeathTitleText)
  }
  return false
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

function isBedWarsPregameCountdown(text: string): boolean {
  const clean = stripColors(text).replace(/\s+/g, ' ').trim()
  return /\bThe game starts in \d+ seconds?\b/i.test(clean)
    || /\bStarting in \d+\s*(?:s|seconds?)\b/i.test(clean)
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

function beginBedWarsPregameTransition(state: SplitReminderState, now: number) {
  if (!state.bedWarsGameActive) return
  if (state.bedWarsPregameSeenAt <= state.bedWarsGameStartedAt) {
    state.stableTeamMaxPlayers = 0
    state.stableTeamMaxPlayersSource = ''
  }
  state.bedWarsPregameSeenAt = now
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
    if (!isBedWarsPregameCountdown(text)) return null
    beginBedWarsPregameTransition(state, now)
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
    sessionState?.knownTeamByPlayerKey.clear()
    sessionState?.knownTeamsByPlayerKey.clear()
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

function offlinePlayerUuid(playerName: string): string {
  const bytes = crypto.createHash('md5').update(`OfflinePlayer:${playerName}`, 'utf8').digest()
  bytes[6] = (bytes[6] & 0x0f) | 0x30
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function teamHasPlayer(team: TeamState, playerName: string): boolean {
  const target = playerKey(playerName)
  for (const player of team.players) {
    if (playerKey(player) === target) return true
  }
  return false
}

function isTrackedBedWarsPlayer(
  state: SessionState,
  splitState: SplitReminderState,
  playerName: string
): boolean {
  const key = playerKey(playerName)
  if (!state.knownPlayersByName.has(key)) return false
  if (splitState.stableTeamPlayersByKey.has(key)) return true
  if (state.knownTeamByPlayerKey.has(key)) return true
  if (state.knownTeamsByPlayerKey.has(key)) return true
  return Array.from(state.teams.values()).some(team => teamHasPlayer(team, playerName))
}

function localPlayerIdentityNames(state: SessionState, localPlayerName: string): string[] {
  const names = new Map(state.localPlayerAliasesByKey)
  const clean = stripColors(localPlayerName).trim()
  if (validPlayerName(clean)) names.set(playerKey(clean), clean)
  return Array.from(names.values())
}

function localPlayerRosterName(state: SessionState, team: TeamState, localPlayerName: string): string {
  for (const identityName of localPlayerIdentityNames(state, localPlayerName)) {
    for (const player of team.players) {
      if (playerKey(player) === playerKey(identityName)) return stripColors(player).trim()
    }
  }
  return stripColors(localPlayerName).trim()
}

function teamHasLocalPlayer(state: SessionState, team: TeamState, localPlayerName: string): boolean {
  return localPlayerIdentityNames(state, localPlayerName).some(identityName => teamHasPlayer(team, identityName))
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

function blockHitSoundStatus() {
  lastBlockHitSoundPollAt = Date.now()
  return { eventId: blockHitSoundEventId }
}

function retainLocalBedWarsTabTeams(state?: SessionState, localPlayerName?: string) {
  if (!state) return
  if (!localPlayerName) {
    state.teams.clear()
    return
  }

  const localPlayer = localPlayerIdentityNames(state, localPlayerName)
    .map(name => state.playersByName.get(playerKey(name)))
    .find(player => !!player)
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
    if (teamLetter !== localLetter && !playerLetterMatches && !teamHasLocalPlayer(state, team, localPlayerName)) {
      state.teams.delete(teamName)
    }
  }
}

function localPlayerTeamCandidates(state: SessionState, localPlayerName: string): TeamState[] {
  const teams = Array.from(state.teams.values()).filter(team => teamHasLocalPlayer(state, team, localPlayerName))
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
  const rosterName = localPlayerRosterName(state, primaryTeam, localPlayerName)
  const tabLetter = bedWarsTabTeamLetter(primaryTeam)
    || bedWarsTabTeamLetterFromPlayerInfo(state.playersByName.get(playerKey(rosterName)))
  const colorName = (tabLetter ? BEDWARS_TAB_TEAM_LETTERS[tabLetter] || null : null)
    || teamColorName(primaryTeam)
    || playerStateColorName(state, rosterName)
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

  addLocalTeamPlayer(playersByKey, rosterName)

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
  const rosterName = localPlayerRosterName(state, snapshot.primaryTeam, localPlayerName)
  addStableTeamPlayer(splitState, rosterName, true)

  for (const player of snapshot.playersByKey.values()) {
    addStableTeamPlayer(splitState, player)
  }
  trimStableTeamPlayers(splitState, rosterName)

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

function isLocalPlayerIdentity(state: SessionState | undefined, localPlayerName: string, playerName: string): boolean {
  if (playerKey(playerName) === playerKey(localPlayerName)) return true
  return !!state?.localPlayerAliasesByKey.has(playerKey(playerName))
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
  if (localPlayerName && isLocalPlayerIdentity(sessionState, localPlayerName, player)) {
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

function localRespawnPlayerName(
  sessionState: SessionState,
  localPlayerName: string,
  splitState: SplitReminderState
): string | null {
  const identityNames = localPlayerIdentityNames(sessionState, localPlayerName)
  const realPlayerKey = playerKey(localPlayerName)
  const preferredIdentity = (names: string[]): string | null => {
    return names.find(name => playerKey(name) !== realPlayerKey)
      || names[0]
      || null
  }

  const stableRosterNames = identityNames
    .map(identityName => splitState.stableTeamPlayersByKey.get(playerKey(identityName)))
    .filter((name): name is string => typeof name === 'string')
  const stableRosterName = preferredIdentity(stableRosterNames)
  if (stableRosterName) return stableRosterName

  for (const team of sessionState.teams.values()) {
    if (!teamHasLocalPlayer(sessionState, team, localPlayerName)) continue
    const rosterName = preferredIdentity(
      identityNames.filter(identityName => teamHasPlayer(team, identityName))
    )
    if (rosterName && validPlayerName(rosterName)) return rosterName
  }

  const uuidRosterKey = sessionState.playerNameByUuid.get(sessionState.localPlayerUuid)
  const uuidRosterPlayer = uuidRosterKey
    ? sessionState.knownPlayersByName.get(uuidRosterKey)
    : null
  if (typeof uuidRosterPlayer?.name === 'string') return uuidRosterPlayer.name

  return identityNames
    .find(name => sessionState.knownPlayersByName.has(playerKey(name))) || null
}

function respawnDeathPlayerName(
  text: string,
  settings: SplitReminderSettings,
  sessionState: SessionState,
  localPlayerName: string,
  splitState: SplitReminderState,
  now = Date.now()
): string | null {
  if (!isLiveBedWarsMatch(sessionState, splitState) || /\bFINAL KILL!/i.test(stripColors(text))) return null
  if (isLocalRespawnCountdownText(text)) return null

  const clean = stripColors(text).trim()
  const localDeath = isLocalDeathText(text, settings)

  if (/^you\b/i.test(clean)) {
    if (!localDeath && !isTeammateDeathText(text, settings)) return null
    return localRespawnPlayerName(sessionState, localPlayerName, splitState)
  }

  const playerName = deathPlayerName(text)
  if (!playerName) return null
  const deathBody = clean.slice(playerName.length).trim()
  if (/^[:>]/.test(deathBody)) return null
  if (/^(?:disconnected|reconnected)\.$/i.test(deathBody)) return null
  const teammateStyleDeath = isTeammateDeathText(text, settings)
  const hypixelKillMessage = /^(?:(?:was|got|fell|slipped|tripped|lost|met|took|died|fought|stumbled|forgot|had|caught|played|howled|stepped|squeaked|hit|be)\b|didn't\b|'s heart was\b).+\.(?: FINAL KILL!)?$/i.test(deathBody)
  return (teammateStyleDeath || hypixelKillMessage)
    ? playerName
    : null
}

function isLiveBedWarsMatch(
  sessionState: SessionState,
  splitState: SplitReminderState
): boolean {
  return splitState.bedWarsGameActive && sessionState.localGameMode !== 3
}

function reconnectedPlayerName(text: string): string | null {
  const match = /^([A-Za-z0-9_]{1,16}) reconnected\.$/i.exec(stripColors(text).trim())
  return match ? match[1] : null
}

function disconnectedWhileRespawningPlayerName(
  playerName: string,
  state: SessionState
): string | null {
  return state.playersByName.has(playerKey(playerName)) ? null : playerName
}

function bedWarsTeamColorFromChatComponent(
  comp: any,
  playerName: string,
  inheritedColor = ''
): string | null {
  if (typeof comp === 'string') {
    const playerAt = comp.toLowerCase().indexOf(playerName.toLowerCase())
    if (playerAt < 0) return null
    const codes = Array.from(comp.slice(0, playerAt).matchAll(/\u00a7([0-9a-f])/gi))
    const legacyColor = codes.length
      ? BEDWARS_LEGACY_CHAT_TEAM_FORMAT[codes[codes.length - 1][1].toLowerCase()]
      : ''
    return BEDWARS_CHAT_TEAM_FORMAT[legacyColor]?.colorName
      || BEDWARS_CHAT_TEAM_FORMAT[inheritedColor.toLowerCase()]?.colorName
      || null
  }
  if (Array.isArray(comp)) {
    for (const child of comp) {
      const color = bedWarsTeamColorFromChatComponent(child, playerName, inheritedColor)
      if (color) return color
    }
    return null
  }
  if (!comp || typeof comp !== 'object') return null

  const color = typeof comp.color === 'string' ? comp.color : inheritedColor
  for (const field of ['extra', 'with']) {
    if (!Array.isArray(comp[field])) continue
    const childColor = bedWarsTeamColorFromChatComponent(comp[field], playerName, color)
    if (childColor) return childColor
  }
  if (typeof comp.text === 'string' && new RegExp(`\\b${escapeRegExp(playerName)}\\b`, 'i').test(comp.text)) {
    const exactPlayerText = playerKey(comp.text) === playerKey(playerName)
    const containsLegacyColor = /\u00a7[0-9a-f]/i.test(comp.text)
    if (exactPlayerText || containsLegacyColor || !['gray', 'dark_gray'].includes(color.toLowerCase())) {
      const legacyColor = bedWarsTeamColorFromChatComponent(comp.text, playerName, color)
      if (legacyColor) return legacyColor
    }
  }
  return null
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

function belowNameHealthComponent(player: any, state?: SessionState): any | null {
  if (!state || typeof player?.name !== 'string') return null
  const objectiveName = state.displayedScoreboardObjectives.get(2)
  if (!objectiveName) return null

  const score = state.scores.get(scoreKey(player.name, objectiveName))
  const value = Number(score?.value)
  if (!Number.isFinite(value)) return null

  return {
    text: '',
    extra: [
      { text: String(value), color: 'white' },
      { text: ' \u2764', color: 'red' }
    ]
  }
}

function localPlayerNametagLines(player: any, nicknames: Map<string, string>, state?: SessionState): any[] | null {
  const nameLine = localPlayerNametagComponent(player, nicknames, state)
  if (!nameLine) return null
  const healthLine = belowNameHealthComponent(player, state)
  return healthLine ? [healthLine, nameLine] : [nameLine]
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
  return key
    ? state.playersByName.get(key) || state.knownPlayersByName.get(key) || null
    : null
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

function displayNameComponent(displayName: string | null, fallbackName: string): any {
  if (!displayName) return { text: fallbackName }
  try {
    return JSON.parse(displayName)
  } catch {
    return legacyFormattedComponent(displayName)
  }
}

function respawnTimerPlayerSnapshot(
  player: any,
  state: SessionState,
  fallbackTeamColorName = ''
): any {
  const teamCandidates = Array.from(new Set([
    ...state.teams.values(),
    ...state.knownTeamByPlayerKey.values(),
    ...(typeof player?.name === 'string'
      ? state.knownTeamsByPlayerKey.get(playerKey(player.name))?.values() || []
      : [])
  ]))
  const colorMatchedTeam = fallbackTeamColorName
    ? teamCandidates.find(candidate => teamColorName(candidate) === fallbackTeamColorName)
    : null
  const team = typeof player?.name === 'string'
    ? colorMatchedTeam
      || nicknameDisplayTeam(state, player.name)
      || state.knownTeamByPlayerKey.get(playerKey(player.name))
    : colorMatchedTeam
  const resolvedColorName = fallbackTeamColorName || (team ? teamColorName(team) || '' : '')
  const resolvedFormat = Object.values(BEDWARS_CHAT_TEAM_FORMAT)
    .find(candidate => candidate.colorName.toLowerCase() === resolvedColorName.toLowerCase())
  if (!team) {
    if (!resolvedFormat) return { ...player }
    return {
      ...player,
      respawnTeamSnapshot: {
        team: '',
        packetName: '',
        colorName: resolvedFormat.colorName,
        prefix: `\u00a7${resolvedFormat.code}${resolvedFormat.letter} \u00a7${resolvedFormat.code}`,
        suffix: ''
      }
    }
  }
  return {
    ...player,
    respawnTeamSnapshot: {
      team: team.team,
      packetName: team.packetName,
      colorName: resolvedColorName,
      prefix: resolvedFormat
        ? `\u00a7${resolvedFormat.code}${resolvedFormat.letter} \u00a7${resolvedFormat.code}`
        : team.prefix,
      suffix: team.suffix
    }
  }
}

function respawnTimerDisplayName(
  player: any,
  nicknames: Map<string, string>,
  state: SessionState,
  remainingSeconds: number | null
): string | null {
  const displayName = localPlayerDisplayName(player, nicknames, state)
  if (remainingSeconds === null) return displayName
  const nickname = nicknameForPlayer(player?.name, nicknames)
  const frozenTeam = player?.respawnTeamSnapshot
  const basePlayerComponent = displayName
    ? displayNameComponent(displayName, nickname || player.name)
    : { text: nickname || player.name }
  const displayText = displayName
    ? flattenChatToText(displayNameComponent(displayName, nickname || player.name))
    : ''
  const frozenLegacyName = `${String(frozenTeam?.prefix || '')}${nickname || player.name}${String(frozenTeam?.suffix || '')}`
  const playerComponent = frozenTeam
    ? !displayName || playerKey(displayText) === playerKey(nickname || player.name)
      ? legacyFormattedComponent(frozenLegacyName)
      : {
        text: '',
        extra: [
          legacyFormattedComponent(String(frozenTeam.prefix || '')),
          basePlayerComponent,
          legacyFormattedComponent(String(frozenTeam.suffix || ''))
        ]
      }
    : basePlayerComponent
  const respawningPlayerText = stripColors(flattenChatToText(playerComponent))

  return JSON.stringify({
    text: '',
    extra: [
      { text: `${remainingSeconds}s `, color: 'gold', bold: true },
      { text: respawningPlayerText, color: 'gray' }
    ]
  })
}

function respawnTabRemovePacket(uuid: string): any {
  return {
    action: 'remove_player',
    data: [{ uuid }]
  }
}

function respawnTabAddPacket(
  playerName: string,
  displayName: string | null,
  properties: any[] = []
): any {
  return {
    action: 'add_player',
    data: [{
      uuid: offlinePlayerUuid(playerName),
      name: playerName,
      properties: Array.isArray(properties)
        ? properties.map(property => ({ ...property }))
        : [],
      gamemode: 0,
      ping: 0,
      displayName
    }]
  }
}

function respawnTabDisplayPacket(playerName: string, displayName: string | null): any {
  return {
    action: 'update_display_name',
    data: [{
      uuid: offlinePlayerUuid(playerName),
      displayName
    }]
  }
}

function withNicknameScoreboardTeam(packet: any, nicknames: Map<string, string>): any {
  return packet
}

function withRespawningPlayersKeptInTeam(
  packet: any,
  respawnTimers: ReturnType<typeof createRespawnTimerState>
): any {
  if (Number(packet?.mode) !== 4) return packet
  const field = Array.isArray(packet?.players)
    ? 'players'
    : Array.isArray(packet?.entities)
      ? 'entities'
      : ''
  if (!field) return packet

  const players = packet[field] as string[]
  const filtered = players.filter(playerName => {
    return !respawnTimers.timersByPlayerKey.has(playerKey(playerName))
  })
  return filtered.length === players.length
    ? packet
    : { ...packet, [field]: filtered }
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

function registerLocalPlayerAlias(state: SessionState, playerName: string): boolean {
  const clean = stripColors(playerName).trim()
  const key = playerKey(clean)
  if (!validPlayerName(clean) || !state.playersByName.has(key)) return false
  if (state.localPlayerAliasesByKey.has(key)) return false
  state.localPlayerAliasesByKey.set(key, clean)
  return true
}

function localPlayerAliasFromNickStatus(text: string, state: SessionState): string | null {
  const clean = stripColors(text).replace(/\s+/g, ' ').trim()
  const match = /\b(?:currently|now)?\s*nicked\s+as\s+([A-Za-z0-9_]{1,16})\b/i.exec(clean)
  if (!match) return null
  const key = playerKey(match[1])
  return state.playersByName.get(key)?.name || null
}

function localPlayerAliasFromChatEcho(text: string, sentMessage: string, state: SessionState): string | null {
  const message = stripColors(sentMessage).trim()
  if (!message || message.startsWith('/')) return null

  const clean = stripColors(text)
  const messageAt = clean.lastIndexOf(message)
  if (messageAt < 0) return null
  const header = clean.slice(0, messageAt)
  const matches: string[] = []

  for (const player of state.playersByName.values()) {
    if (typeof player?.name !== 'string' || !validPlayerName(player.name)) continue
    const pattern = new RegExp(`(?:^|[^A-Za-z0-9_])${escapeRegExp(player.name)}(?:$|[^A-Za-z0-9_])`, 'i')
    if (pattern.test(header)) matches.push(player.name)
  }

  return matches.length === 1 ? matches[0] : null
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
  const sidebarObjective = state.displayedScoreboardObjectives.get(1)

  for (const score of state.scores.values()) {
    if (typeof score?.itemName !== 'string') continue
    if (sidebarObjective && score?.scoreName !== sidebarObjective) continue
    lines.push(...scoreboardLinesForItem(score.itemName, state))
  }

  if (!sidebarObjective) {
    for (const team of state.teams.values()) {
      lines.push(`${team.team} ${team.prefix || ''} ${team.suffix || ''}`)
    }
  }

  return Array.from(new Set(lines))
}

function activeBedWarsTeamColors(state: SessionState): Set<BedWarsTeamColor> {
  const teams = new Set<BedWarsTeamColor>()
  const teamPattern = /\b(Red|Blue|Green|Yellow|Aqua|White|Pink|Gray):\s*(?:\u2713|\u2714)/gi
  for (const text of scoreboardModeTexts(state)) {
    const clean = stripColors(text).replace(/\s+/g, ' ')
    for (const match of clean.matchAll(teamPattern)) {
      const name = match[1][0].toUpperCase() + match[1].slice(1).toLowerCase()
      teams.add(name as BedWarsTeamColor)
    }
  }
  return teams
}

function isBedDefenseScoreboardContext(state: SessionState): boolean {
  return scoreboardModeTexts(state).some(text => (
    isBedWarsPregameCountdown(text) || isActiveBedWarsMatchScoreboardText(text)
  ))
}

function obsidianHoldersFromSession(
  state: SessionState,
  activeTeams: ReadonlySet<BedWarsTeamColor>
): ObsidianHolderDetection[] {
  const detections: ObsidianHolderDetection[] = []
  for (const entity of state.playerEntitiesByUuid.values()) {
    if (!equipmentPacketHoldsObsidian(entity.equipment.get(0))) continue
    const playerKeyValue = state.playerNameByUuid.get(entity.uuid) || ''
    const profile = state.knownPlayersByName.get(playerKeyValue)
    const playerName = typeof profile?.name === 'string' ? profile.name : playerKeyValue
    if (!validPlayerName(playerName)) continue
    const teamCandidates = Array.from(state.knownTeamsByPlayerKey.get(playerKeyValue)?.values() || [])
    const primaryTeam = state.knownTeamByPlayerKey.get(playerKeyValue)
    if (primaryTeam) teamCandidates.unshift(primaryTeam)
    const team = teamCandidates
      .map(candidate => teamColorName(candidate))
      .find((color): color is BedWarsTeamColor => Boolean(color && activeTeams.has(color as BedWarsTeamColor)))
    if (team) detections.push({ team, playerName, source: 'held' })
  }
  return detections
}

function bedWarsMapNameFromScoreboard(state: SessionState): string | null {
  for (const text of scoreboardModeTexts(state)) {
    const clean = stripColors(text).replace(/\s+/g, ' ').trim()
    const match = /(?:^|\s)Map:\s*([A-Za-z0-9][A-Za-z0-9 _'-]{0,48})\s*$/i.exec(clean)
    if (match) {
      return match[1]
        .trim()
        .replace(/\b([A-Za-z]{2,})\s+([A-Za-z])$/, '$1$2')
    }
  }
  return null
}

function currentBedWarsModeName(state: SessionState, splitState: SplitReminderState): string | null {
  if (splitState.stableTeamMaxPlayersSource.startsWith('mode:')) {
    return splitState.stableTeamMaxPlayersSource.slice('mode:'.length) || null
  }
  for (const text of scoreboardModeTexts(state)) {
    const mode = bedWarsTeamModeFromText(text)
    if (mode) return mode.label
  }
  const scoreboardMode = inferBedWarsModeFromScoreboardGroups(state)
  if (scoreboardMode) return scoreboardMode.label

  const groups = new Map<string, Set<string>>()
  for (const player of state.knownPlayersByName.values()) {
    const letter = bedWarsTabTeamLetterFromPlayerInfo(player)
    const name = stripColors(String(player?.name || '')).trim()
    if (!letter || !validPlayerName(name)) continue
    if (!groups.has(letter)) groups.set(letter, new Set())
    groups.get(letter)!.add(playerKey(name))
  }
  const sizes = Array.from(groups.values()).map(group => group.size)
  if (groups.size >= 6) return Math.max(...sizes, 0) >= 2 ? 'Doubles' : 'Solo'
  if (groups.size >= 3) {
    const largest = Math.max(...sizes, 0)
    if (largest >= 4) return '4v4v4v4'
    if (largest >= 3) return '3v3v3v3'
  }
  return null
}

function blockedPlayerTeamContext(
  state: SessionState,
  playerName: string,
  maxPlayers = MAX_BEDWARS_TEAM_PLAYERS
): { team?: string; teammates: string[] } {
  const targetKey = playerKey(playerName)
  const players = Array.from(new Map([
    ...state.knownPlayersByName.entries(),
    ...state.playersByName.entries()
  ]).values())
  const blockedPlayer = players.find(player => playerKey(String(player?.name || '')) === targetKey)
  const tabLetter = bedWarsTabTeamLetterFromPlayerInfo(blockedPlayer)
  const knownTeams = new Set<TeamState>(state.teams.values())
  for (const team of state.knownTeamByPlayerKey.values()) knownTeams.add(team)
  for (const teams of state.knownTeamsByPlayerKey.values()) {
    for (const team of teams.values()) knownTeams.add(team)
  }

  if (tabLetter) {
    const colorName = BEDWARS_TAB_TEAM_LETTERS[tabLetter] || null
    const teammates = new Set(players
      .filter(player => {
        return bedWarsTabTeamLetterFromPlayerInfo(player) === tabLetter
          || (!!colorName && playerDisplayColorName(player) === colorName)
      })
      .map(player => stripColors(String(player?.name || '')).trim())
      .filter(name => validPlayerName(name) && playerKey(name) !== targetKey)
    )
    for (const team of knownTeams) {
      if (
        bedWarsTabTeamLetter(team) !== tabLetter
        && (!colorName || !teamIncludesColorName(state, team, colorName))
      ) continue
      for (const name of team.players) {
        const clean = stripColors(name).trim()
        if (validPlayerName(clean) && playerKey(clean) !== targetKey) teammates.add(clean)
      }
    }
    return {
      team: colorName || tabLetter,
      teammates: Array.from(teammates).slice(0, Math.max(0, maxPlayers - 1))
    }
  }

  const candidates = Array.from(new Set([
    ...(state.knownTeamsByPlayerKey.get(targetKey)?.values() || []),
    ...(state.knownTeamByPlayerKey.has(targetKey) ? [state.knownTeamByPlayerKey.get(targetKey)!] : []),
    ...Array.from(state.teams.values()).filter(team => teamHasPlayer(team, playerName))
  ])).filter(team => team.players.size <= MAX_BEDWARS_TEAM_PLAYERS)
  candidates.sort((left, right) => {
    const score = (team: TeamState) => (bedWarsTabTeamName(team) ? 100 : 0) + (teamColorName(team) ? 20 : 0) + team.players.size
    return score(right) - score(left)
  })
  const team = candidates[0]
  if (!team) return { teammates: [] }

  const teamLetter = bedWarsTabTeamLetter(team)
  const colorName = teamColorName(team)
  const teammates = new Set<string>()
  for (const candidate of knownTeams) {
    const matches = teamLetter
      ? bedWarsTabTeamLetter(candidate) === teamLetter
      : !!colorName && teamIncludesColorName(state, candidate, colorName)
    if (!matches) continue
    for (const name of candidate.players) {
      const clean = stripColors(name).trim()
      if (validPlayerName(clean) && playerKey(clean) !== targetKey) teammates.add(clean)
    }
  }

  return {
    team: teamDisplayName(team),
    teammates: Array.from(teammates).slice(0, Math.max(0, maxPlayers - 1))
  }
}

function localTeammatesForBlockContext(
  state: SessionState,
  localPlayerName: string,
  maxPlayers: number
): string[] {
  const identities = localPlayerIdentityNames(state, localPlayerName)
  const identityKeys = new Set(identities.map(playerKey))
  const candidates = identities
    .map(identity => blockedPlayerTeamContext(state, identity, maxPlayers).teammates)
    .sort((left, right) => right.length - left.length)
  return Array.from(new Set(candidates[0] || []))
    .filter(name => !identityKeys.has(playerKey(name)))
    .slice(0, Math.max(0, maxPlayers - 1))
}

function isActiveBedWarsMatchScoreboardText(text: string): boolean {
  const clean = stripColors(text).replace(/\s+/g, ' ').trim()
  return /\b(?:Diamond|Emerald)\s+[IVX]+\s+in\s+\d+:\d+\b/i.test(clean)
}

function scoreboardSidebarObjectiveWillChange(packet: any, state: SessionState): boolean {
  if (Number(packet?.position) !== 1) return false
  const currentObjective = state.displayedScoreboardObjectives.get(1) || ''
  const nextObjective = typeof packet?.name === 'string' ? packet.name : ''
  return currentObjective !== nextObjective
}

function removesDisplayedScoreboardObjective(packet: any, state: SessionState): boolean {
  if (typeof packet?.name !== 'string' || Number(packet.action) !== 1) return false
  return Array.from(state.displayedScoreboardObjectives.values())
    .some(objectiveName => objectiveName === packet.name)
}

function restoreBedWarsGameStateFromScoreboard(
  state: SessionState,
  splitState: SplitReminderState,
  now = Date.now()
): boolean {
  if (splitState.bedWarsGameActive) return false
  if (state.localGameMode === 3) return false
  if (!scoreboardModeTexts(state).some(isActiveBedWarsMatchScoreboardText)) return false
  resetSplitReminderMatchState(splitState, true, now)
  return true
}

function updateBedWarsModeFromScoreboard(
  state: SessionState,
  splitState: SplitReminderState,
  now = Date.now()
): { label: string; maxPlayers: number } | null {
  const texts = scoreboardModeTexts(state)
  const countdownVisible = texts.some(isBedWarsPregameCountdown)
  const countdownBecameVisible = countdownVisible && !splitState.bedWarsScoreboardCountdownVisible
  splitState.bedWarsScoreboardCountdownVisible = countdownVisible

  if (
    splitState.bedWarsGameActive &&
    countdownBecameVisible &&
    now - splitState.bedWarsGameStartedAt >= BEDWARS_ROSTER_SETTLE_MS
  ) {
    beginBedWarsPregameTransition(splitState, now)
  }

  if (splitState.stableTeamMaxPlayersSource.startsWith('mode:')) return null

  let modeText: string | null = null
  for (const text of texts) {
    if (bedWarsTeamModeFromText(text)) modeText = text
  }

  const detected = modeText ? applyBedWarsTeamModeFromText(modeText, splitState) : null
  const nextGamePregameActive =
    splitState.bedWarsGameActive &&
    splitState.bedWarsPregameSeenAt > splitState.bedWarsGameStartedAt

  return detected || (nextGamePregameActive ? null : applyBedWarsTeamModeFromScoreboardGroups(state, splitState))
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
    const lines = localPlayerNametagLines(player, nicknames, state)
    if (!lines) {
      if (targetKey) writeApolloJson(downstream, resetApolloNametagMessage(player.uuid))
      continue
    }
    writeApolloJson(downstream, overrideApolloNametagMessage(player.uuid, lines))
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

type NicknameCommand =
  | { action: 'add'; player: string; nickname: string }
  | { action: 'remove'; player: string }
  | { action: 'list'; page: number }
  | { action: 'help' }

const NICKNAME_LIST_PAGE_SIZE = 8

function parseNicknameValue(value: string): string | null {
  let nickname = value.trim()
  if (!nickname) return null
  if (nickname.startsWith('"') || nickname.endsWith('"')) {
    const quoted = /^"([^"]+)"$/.exec(nickname)
    if (!quoted) return null
    nickname = quoted[1].trim()
  }
  return nickname || null
}

function parseNicknameCommand(message: string): NicknameCommand | null {
  const directList = /^\s*\/(?:nicknames|nl)(?:\s+(\d+))?\s*$/i.exec(message)
  if (directList) return { action: 'list', page: Math.max(1, Number(directList[1] || 1)) }

  const directRemove = /^\s*\/nr\s+([A-Za-z0-9_]{1,16})\s*$/i.exec(message)
  if (directRemove) return { action: 'remove', player: directRemove[1] }

  const command = /^\s*\/(nickname|n)(?:\s+(.*?))?\s*$/i.exec(message)
  if (!command) return null

  const commandName = command[1].toLowerCase()
  const args = (command[2] || '').trim()
  const list = /^(?:list|l)(?:\s+(\d+))?$/i.exec(args)
  if (list) return { action: 'list', page: Math.max(1, Number(list[1] || 1)) }

  const remove = /^(?:remove|r|clear|delete)\s+([A-Za-z0-9_]{1,16})$/i.exec(args)
  if (remove) return { action: 'remove', player: remove[1] }

  const add = /^(?:add|a)\s+([A-Za-z0-9_]{1,16})\s+(.+)$/i.exec(args)
  if (add) {
    const nickname = parseNicknameValue(add[2])
    return nickname
      ? { action: 'add', player: add[1], nickname }
      : { action: 'help' }
  }

  if (commandName === 'n') {
    const directAdd = /^([A-Za-z0-9_]{1,16})\s+(.+)$/.exec(args)
    if (directAdd && !/^(?:add|a|remove|r|clear|delete|list|l)$/i.test(directAdd[1])) {
      const nickname = parseNicknameValue(directAdd[2])
      if (nickname) return { action: 'add', player: directAdd[1], nickname }
    }
  }

  return { action: 'help' }
}

function nicknameListPage(
  nicknames: Map<string, string>,
  requestedPage = 1
): { page: number; totalPages: number; components: any[] } {
  const rows = Array.from(nicknames.entries()).sort(([left], [right]) => left.localeCompare(right))
  const totalPages = Math.max(1, Math.ceil(rows.length / NICKNAME_LIST_PAGE_SIZE))
  const page = Math.min(totalPages, Math.max(1, Math.floor(requestedPage) || 1))
  const pageRows = rows.slice((page - 1) * NICKNAME_LIST_PAGE_SIZE, page * NICKNAME_LIST_PAGE_SIZE)
  const divider = { text: '----------------------------------------', color: 'dark_blue' }
  const headerExtra: any[] = [
    { text: '       Nicknames ', color: 'gold' },
    { text: `(Page ${page} of ${totalPages})`, color: 'yellow' }
  ]

  if (page > 1) {
    headerExtra.push({
      text: ' <<',
      color: 'yellow',
      bold: true,
      clickEvent: { action: 'run_command', value: `/n list ${page - 1}` },
      hoverEvent: { action: 'show_text', value: { text: 'Previous page', color: 'yellow' } }
    })
  }
  if (page < totalPages) {
    headerExtra.push({
      text: ' >>',
      color: 'yellow',
      bold: true,
      clickEvent: { action: 'run_command', value: `/n list ${page + 1}` },
      hoverEvent: { action: 'show_text', value: { text: 'Next page', color: 'yellow' } }
    })
  }

  const components: any[] = [divider, { text: '', extra: headerExtra }]
  if (!pageRows.length) {
    components.push({ text: 'No nicknames saved.', color: 'red' })
  } else {
    for (const [player, nickname] of pageRows) {
      components.push({
        text: '',
        extra: [
          {
            text: player,
            color: 'aqua',
            clickEvent: { action: 'suggest_command', value: `/nickname remove ${player}` },
            hoverEvent: { action: 'show_text', value: { text: 'Click to prepare removal', color: 'red' } }
          },
          { text: ' is shown as ', color: 'gray' },
          { text: nickname, color: 'green' }
        ]
      })
    }
  }
  components.push(divider)
  return { page, totalPages, components }
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
  const blockNickHistory = loadBlockNickHistory()
  const blockHitSound = createBlockHitSoundState()
  const obsidianDetector = createObsidianDetectorState()
  const bedDefense = createBedDefenseState()
  const pendingHeldItemsByEntityId = new Map<number, any>()
  const pendingBedDefenseChunks = new Map<string, BedDefenseChunkPacket>()
  let bedDefenseScanScheduled = false
  let bedDefenseChunkScanningArmed = false
  let bedDefenseWorldGeneration = 0
  let bridgeClosed = false
  let lastLobbyCommandKey = ''
  let lastLobbyCommandAt = 0
  let currentWindowId = -1
  let currentWindowTitle = ''
  let currentWindowIsLobbySelector = false
  let lastLobbyWindowClickKey = ''
  let lastLobbyWindowClickAt = 0
  let lastScoreboardAnalysisAt = 0
  let scoreboardAnalysisDeferred = false
  let allowBedWarsScoreboardRecovery = true
  let lastBedWarsMapName = ''
  let recentLocalChat: { message: string; sentAt: number } | null = null
  let lastRespawnDeathKey = ''
  let lastRespawnDeathAt = 0
  const respawnTimers = createRespawnTimerState()
  const respawnProfilesByPlayerKey = new Map<string, any>()
  const syntheticRespawnPlayers = new Set<string>()
  const pendingRespawnDisconnectChecks = new Map<string, { playerName: string; checkAt: number }>()
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

  const heldObsidianDetectorEnabled = () => appConfig.bedWars.obsidianDetectorMode !== 'base'
  const baseObsidianDetectorEnabled = () => appConfig.bedWars.obsidianDetectorMode !== 'held'

  const invalidateBedDefenseChunkQueue = () => {
    bedDefenseWorldGeneration += 1
    pendingBedDefenseChunks.clear()
  }

  const scheduleBedDefenseChunkScan = () => {
    if (bedDefenseScanScheduled || !pendingBedDefenseChunks.size || bridgeClosed) return
    const generation = bedDefenseWorldGeneration
    bedDefenseScanScheduled = true
    const timer = setTimeout(() => scanNextBedDefenseChunk(generation), BED_DEFENSE_SCAN_DELAY_MS)
    timer.unref?.()
  }

  const queueBedDefenseChunks = (packets: BedDefenseChunkPacket[]) => {
    if (
      !appConfig.bedWars.obsidianDetectorEnabled
      || !baseObsidianDetectorEnabled()
      || !bedDefenseChunkScanningArmed
      || bridgeClosed
    ) return
    for (const packet of packets) {
      const key = `${packet.x},${packet.z}`
      if (!pendingBedDefenseChunks.has(key) && pendingBedDefenseChunks.size >= BED_DEFENSE_MAX_PENDING_CHUNKS) {
        const oldestKey = pendingBedDefenseChunks.keys().next().value
        if (typeof oldestKey === 'string') pendingBedDefenseChunks.delete(oldestKey)
      }
      pendingBedDefenseChunks.set(key, packet)
    }
    scheduleBedDefenseChunkScan()
  }

  const scanNextBedDefenseChunk = (generation: number) => {
    bedDefenseScanScheduled = false
    if (bridgeClosed || !bedDefenseChunkScanningArmed || generation !== bedDefenseWorldGeneration) {
      if (bridgeClosed || !bedDefenseChunkScanningArmed) pendingBedDefenseChunks.clear()
      else scheduleBedDefenseChunkScan()
      return
    }
    const next = pendingBedDefenseChunks.entries().next()
    if (next.done) return
    const [key, packet] = next.value
    pendingBedDefenseChunks.delete(key)
    observeBedDefenseChunk(packet, bedDefense)
    // Learn clean base ownership even during pregame, before player wool is placed.
    bedDefenseDetections(bedDefense)
    announceBaseObsidianDetections()
    scheduleBedDefenseChunkScan()
  }

  const analyzeScoreboard = (force = false) => {
    const detectedMap = bedWarsMapNameFromScoreboard(sessionState)
    if (detectedMap) lastBedWarsMapName = detectedMap
    if (isBedDefenseScoreboardContext(sessionState)) bedDefenseChunkScanningArmed = true
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

  const playMinecraftBlockHitSound = (force = false): boolean => {
    if ((!force && !appConfig.qol.blockHitSoundEnabled) || downstream.state !== 'play') return false
    const volumePercent = appConfig.qol.blockHitSoundVolume
    const packet = blockHitSoundPacket(blockHitSound, volumePercent / 100)
    if (!packet || volumePercent <= 0) return false
    try {
      downstream.write('named_sound_effect', packet)
      return true
    } catch {
      return false
    }
  }
  const announceBlockHitSound = (force = false): boolean => {
    if (!force && !appConfig.qol.blockHitSoundEnabled) return false
    blockHitSoundEventId += 1
    if (Date.now() - lastBlockHitSoundPollAt <= 1000) return true
    return playMinecraftBlockHitSound(force)
  }
  const testThisSessionBlockHitSound = () => announceBlockHitSound(true)
  activeBlockHitSoundTests.add(testThisSessionBlockHitSound)

  const obsidianTeamColor: Record<string, string> = {
    Red: 'red',
    Blue: 'blue',
    Green: 'green',
    Yellow: 'yellow',
    Aqua: 'aqua',
    White: 'white',
    Pink: 'light_purple',
    Gray: 'gray'
  }

  const obsidianDetectionChat = (detection: ObsidianHolderDetection) => ({
    text: '',
    extra: [
      { text: '[Obsidian] ', color: 'dark_purple', bold: true },
      { text: detection.team, color: obsidianTeamColor[detection.team] || 'white', bold: true },
      { text: ' team has obsidian', color: 'yellow' },
      {
        text: detection.source === 'held'
          ? ` (held by ${detection.playerName}).`
          : ' (detected at their bed).',
        color: 'gray'
      }
    ]
  })

  const announceObsidianHolders = () => {
    if (!appConfig.bedWars.obsidianDetectorEnabled) return
    if (!heldObsidianDetectorEnabled()) return
    if (!isLiveBedWarsMatch(sessionState, splitReminderState)) return
    const activeTeams = activeBedWarsTeamColors(sessionState)
    if (!activeTeams.size) return
    for (const detection of obsidianHoldersFromSession(sessionState, activeTeams)) {
      const { team, playerName } = detection
      if (!rememberObsidianHolder(obsidianDetector, detection)) continue
      sendClientChat(downstream, obsidianDetectionChat(detection))
      splitSoundEventId += 1
      term('QoL', `${playerName} on ${team} was seen holding obsidian.`, colors.magenta)
    }
  }

  const announceBaseObsidianDetections = () => {
    if (!appConfig.bedWars.obsidianDetectorEnabled || !baseObsidianDetectorEnabled()) return
    if (!isLiveBedWarsMatch(sessionState, splitReminderState)) return
    const activeTeams = activeBedWarsTeamColors(sessionState)
    if (!activeTeams.size) return
    for (const base of bedDefenseDetections(bedDefense, activeTeams)) {
      const detection: ObsidianHolderDetection = {
        team: base.team,
        playerName: 'Base detector',
        source: 'base'
      }
      if (!rememberObsidianHolder(obsidianDetector, detection)) continue
      sendClientChat(downstream, obsidianDetectionChat(detection))
      splitSoundEventId += 1
      term('QoL', `Obsidian detected at ${base.team} bed.`, colors.magenta)
    }
  }

  const announceAllObsidianDetections = () => {
    announceObsidianHolders()
    announceBaseObsidianDetections()
  }

  const recoverBedWarsStateFromScoreboard = () => {
    if (!allowBedWarsScoreboardRecovery) return
    if (!restoreBedWarsGameStateFromScoreboard(sessionState, splitReminderState)) return
    allowBedWarsScoreboardRecovery = false
    transferWatch.active = false
    scoreboardAnalysisDeferred = false
  }

  const analyzeTeamAfterGameStart = (previousGameStartedAt: number) => {
    if (!splitReminderState.bedWarsGameActive) return
    if (splitReminderState.bedWarsGameStartedAt === previousGameStartedAt) return

    // Pregame chunks are useful for learning which permanent wool belongs to
    // each base, but any obsidian present in that snapshot is map data rather
    // than a player-placed defense. Only live-match updates may count.
    clearBedDefenseObsidian(bedDefense)
    invalidateBedDefenseChunkQueue()

    // The transfer guard should not hide the new match roster for 20 seconds.
    transferWatch.active = false
    analyzeScoreboard(true)
  }

  const writeRespawnTimerPlayer = (
    playerName: string,
    remainingSeconds: number | null,
    scheduleDisconnectCheck = true
  ) => {
    const key = playerKey(playerName)
    const player = respawnProfilesByPlayerKey.get(key)
      || sessionState.knownPlayersByName.get(key)
    if (!player || downstream.state !== 'play') return
    const syntheticUuid = offlinePlayerUuid(playerName)

    try {
      if (remainingSeconds !== null) {
        const displayName = respawnTimerDisplayName(player, nicknames, sessionState, remainingSeconds)
        if (!syntheticRespawnPlayers.has(key)) {
          downstream.write('player_info', respawnTabRemovePacket(player.uuid))
          downstream.write('player_info', respawnTabAddPacket(playerName, displayName, player.properties))
          syntheticRespawnPlayers.add(key)
        } else {
          downstream.write('player_info', respawnTabDisplayPacket(playerName, displayName))
        }
        return
      }

      if (syntheticRespawnPlayers.delete(key)) {
        downstream.write('player_info', respawnTabRemovePacket(syntheticUuid))
      }
      const activePlayer = sessionState.playersByName.get(key)
      if (activePlayer) {
        const restorePacket = withNicknamePlayerInfo({
          action: 'add_player',
          data: [activePlayer]
        }, nicknames, sessionState)
        downstream.write('player_info', restorePacket)
      }
      if (scheduleDisconnectCheck) {
        pendingRespawnDisconnectChecks.set(key, {
          playerName,
          checkAt: Date.now() + 500
        })
      }
    } catch {}
  }

  const sendRespawnDisconnectMessage = (playerName: string) => {
    if (downstream.state !== 'play') return
    try {
      downstream.write('chat', {
        message: JSON.stringify({
          text: '',
          extra: [
            { text: playerName, color: 'gold' },
            { text: ' disconnected while respawning.', color: 'gray' }
          ]
        }),
        position: 0
      })
    } catch {}
  }

  const flushRespawnTimers = (now = Date.now()) => {
    if (!appConfig.bedWars.respawnTimerEnabled || !isLiveBedWarsMatch(sessionState, splitReminderState)) {
      if (
        respawnTimers.timersByPlayerKey.size
        || pendingRespawnDisconnectChecks.size
        || syntheticRespawnPlayers.size
      ) {
        clearActiveRespawnTimers(true)
      }
      return
    }
    for (const update of collectRespawnTimerUpdates(respawnTimers, now)) {
      writeRespawnTimerPlayer(update.playerName, update.remainingSeconds)
    }
    for (const [key, pending] of pendingRespawnDisconnectChecks) {
      if (now < pending.checkAt) continue
      pendingRespawnDisconnectChecks.delete(key)
      const disconnectedPlayer = disconnectedWhileRespawningPlayerName(pending.playerName, sessionState)
      if (disconnectedPlayer) {
        sendRespawnDisconnectMessage(disconnectedPlayer)
      }
      respawnProfilesByPlayerKey.delete(key)
    }
  }

  const clearActiveRespawnTimers = (restoreDisplayNames: boolean) => {
    const playerNames = clearRespawnTimers(respawnTimers)
    for (const playerName of playerNames) {
      const key = playerKey(playerName)
      if (restoreDisplayNames) {
        writeRespawnTimerPlayer(playerName, null, false)
      } else {
        try {
          if (syntheticRespawnPlayers.delete(key) && downstream.state === 'play') {
            downstream.write('player_info', respawnTabRemovePacket(offlinePlayerUuid(playerName)))
          }
        } catch {}
        respawnProfilesByPlayerKey.delete(key)
      }
    }
    pendingRespawnDisconnectChecks.clear()
    if (!restoreDisplayNames) respawnProfilesByPlayerKey.clear()
  }

  const resetForScoreboardTransition = () => {
    clearActiveRespawnTimers(false)
    resetObsidianDetectorState(obsidianDetector)
    resetBedDefenseState(bedDefense)
    invalidateBedDefenseChunkQueue()
    pruneSessionHistory(sessionState, { clearEntities: true })
    resetSplitReminderMatchState(splitReminderState, false)
    allowBedWarsScoreboardRecovery = true
    lastRespawnDeathKey = ''
    lastRespawnDeathAt = 0
  }

  const beginRespawnTimer = (
    playerName: string,
    now: number,
    durationMs?: number,
    fallbackTeamColorName = ''
  ) => {
    if (!appConfig.bedWars.respawnTimerEnabled) return
    const key = playerKey(playerName)
    const player = sessionState.knownPlayersByName.get(key) || {
      uuid: offlinePlayerUuid(playerName),
      name: playerName,
      properties: [],
      gamemode: 0,
      ping: 0,
      displayName: null
    }
    const snapshot = respawnTimerPlayerSnapshot(player, sessionState, fallbackTeamColorName)
    respawnProfilesByPlayerKey.set(key, snapshot)
    pendingRespawnDisconnectChecks.delete(key)
    startRespawnTimer(respawnTimers, playerName, now, durationMs)
    flushRespawnTimers(now)
  }

  const respawnTimerInterval = setInterval(() => flushRespawnTimers(), 250)
  respawnTimerInterval.unref?.()

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
    if (meta.name === 'map_chunk') {
      queueBedDefenseChunks([data as BedDefenseChunkPacket])
    } else if (meta.name === 'map_chunk_bulk') {
      queueBedDefenseChunks(bedDefenseBulkChunks(data))
    }
    if (shouldRawForwardUpstreamPacket(meta.name)) return

    try {
      if (meta.name === 'login' || meta.name === 'respawn') {
        clearSessionEntityHistory(sessionState)
        trackLocalGameMode(data, sessionState)
        bedDefenseChunkScanningArmed = false
        invalidateBedDefenseChunkQueue()
        if (meta.name === 'login') {
          trackBlockHitLocalEntity(data, blockHitSound)
          resetObsidianDetectorState(obsidianDetector)
          resetBedDefenseState(bedDefense)
        }
        resetBlockHitSoundState(blockHitSound)
        startTransferWatch()
        if (!isLiveBedWarsMatch(sessionState, splitReminderState)) {
          clearActiveRespawnTimers(true)
        }
      }
      if (meta.name === 'update_health') {
        const playSound = observeBlockHitHealth(data, blockHitSound)
        downstream.write(meta.name, data)
        if (playSound) announceBlockHitSound()
        return
      }
      if (meta.name === 'entity_status') {
        const playSound = observeBlockHitEntityStatus(data, blockHitSound)
        downstream.write(meta.name, data)
        if (playSound) announceBlockHitSound()
        return
      }
      if (meta.name === 'block_change') {
        observeBedDefenseBlockChange(data, bedDefense)
        downstream.write(meta.name, data)
        announceBaseObsidianDetections()
        return
      }
      if (meta.name === 'multi_block_change') {
        observeBedDefenseMultiBlockChange(data, bedDefense)
        downstream.write(meta.name, data)
        announceBaseObsidianDetections()
        return
      }
      if (meta.name === 'chat') {
        const raw = (data as any).message
        const position = (data as any).position ?? 0
        let comp = (() => {
          try {
            return JSON.parse(raw)
          } catch {
            return raw
          }
        })()
        const now = Date.now()
        const blockListObservation = observeBlockListChat(blockNickHistory, comp, now)
        comp = blockListObservation.component
        if (blockListObservation.changed) saveBlockNickHistory(blockNickHistory)
        if (blockListObservation.learned) {
          term(
            'QoL',
            `Block list linked ${blockListObservation.learned.currentName} to previous name(s): ${blockListObservation.learned.previousNames.join(', ')}.`,
            colors.yellow
          )
        }
        const detectedLocalAlias = localPlayerAliasFromNickStatus(flattenChatToText(comp), sessionState)
          || (
            recentLocalChat && now - recentLocalChat.sentAt <= 5000
              ? localPlayerAliasFromChatEcho(flattenChatToText(comp), recentLocalChat.message, sessionState)
              : null
          )
        if (detectedLocalAlias && registerLocalPlayerAlias(sessionState, detectedLocalAlias)) {
          term('QoL', `Local Hypixel nick detected: ${downstream.username} -> ${detectedLocalAlias}.`, colors.yellow)
          analyzeScoreboard(true)
        }
        if (recentLocalChat && flattenChatToText(comp).includes(recentLocalChat.message)) {
          recentLocalChat = null
        }
        const gameStartedAtBeforeChat = splitReminderState.bedWarsGameStartedAt
        const gameEvent = bedWarsGameEvent(flattenChatToText(comp))
        if (gameEvent === 'start' || gameEvent === 'pregame') bedDefenseChunkScanningArmed = true
        if (gameEvent === 'end') {
          bedDefenseChunkScanningArmed = false
          invalidateBedDefenseChunkQueue()
        }
        if (gameEvent === 'start') resetObsidianDetectorState(obsidianDetector)
        if (gameEvent === 'start' || gameEvent === 'end' || isBedWarsPregameCountdown(flattenChatToText(comp))) {
          allowBedWarsScoreboardRecovery = false
        }
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
        if (splitReminderState.bedWarsGameStartedAt !== gameStartedAtBeforeChat) {
          clearActiveRespawnTimers(false)
          pruneSessionHistory(sessionState, { clearEntities: true })
        }
        const deathText = flattenChatToText(comp)
        const localCountdownSeconds = localRespawnCountdownSeconds(deathText)
        if (localCountdownSeconds !== null && isLiveBedWarsMatch(sessionState, splitReminderState)) {
          const localRespawnName = localRespawnPlayerName(
            sessionState,
            downstream.username,
            splitReminderState
          )
          if (localRespawnName) {
            const currentSeconds = respawnTimerSeconds(respawnTimers, localRespawnName, now)
            if (currentSeconds === null || localCountdownSeconds > currentSeconds + 1) {
              beginRespawnTimer(
                localRespawnName,
                now,
                localCountdownSeconds * 1000,
                splitReminderState.stableTeamColorName
              )
            }
          }
        }
        const deadPlayer = respawnDeathPlayerName(
          deathText,
          appConfig.splitReminder,
          sessionState,
          downstream.username,
          splitReminderState,
          now
        )
        if (deadPlayer) {
          const deathKey = `${playerKey(deadPlayer)}:${stripColors(deathText)}`
          if (deathKey !== lastRespawnDeathKey || now - lastRespawnDeathAt > 1000) {
            lastRespawnDeathKey = deathKey
            lastRespawnDeathAt = now
            beginRespawnTimer(
              deadPlayer,
              now,
              undefined,
              bedWarsTeamColorFromChatComponent(comp, deadPlayer) || ''
            )
          }
        }
        const reconnectedPlayer = reconnectedPlayerName(deathText)
        if (
          reconnectedPlayer
          && isLiveBedWarsMatch(sessionState, splitReminderState)
          && isTrackedBedWarsPlayer(sessionState, splitReminderState, reconnectedPlayer)
        ) {
          beginRespawnTimer(reconnectedPlayer, now, BEDWARS_RECONNECT_RESPAWN_MS)
        }
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
        const titleNow = Date.now()
        if (packetHasLocalDeathTitleText(data) && isLiveBedWarsMatch(sessionState, splitReminderState)) {
          const localRespawnName = localRespawnPlayerName(
            sessionState,
            downstream.username,
            splitReminderState
          )
          if (
            localRespawnName
            && respawnTimerSeconds(respawnTimers, localRespawnName, titleNow) === null
          ) {
            beginRespawnTimer(
              localRespawnName,
              titleNow,
              undefined,
              splitReminderState.stableTeamColorName
            )
          }
        }
        const pendingBeforeTitle = splitReminderState.splitPending
        const trigger = splitReminderState.lastTrigger
        const updated = withSplitReminderPacket(
          meta.name,
          data,
          splitReminderState,
          appConfig.splitReminder,
          titleNow,
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
        const withNicknames = withNicknamePlayerInfo(data, nicknames, sessionState)
        downstream.write(meta.name, withNicknames)
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
        const downstreamTeamPacket = withRespawningPlayersKeptInTeam(data, respawnTimers)
        trackScoreboardTeam(meta.name, data, sessionState, nicknames)
        recoverBedWarsStateFromScoreboard()
        analyzeScoreboard()
        announceAllObsidianDetections()
        downstream.write(meta.name, withNicknameScoreboardTeam(downstreamTeamPacket, nicknames))
        const currentPlayers = typeof (data as any)?.team === 'string'
          ? Array.from(sessionState.teams.get((data as any).team)?.players || [])
          : []
        const affectedPlayers = [...previousPlayers, ...teamPlayers(data), ...currentPlayers]
        refreshNicknameTabPlayers(downstream, sessionState, nicknames, affectedPlayers)
        refreshApolloPlayers(affectedPlayers)
        return
      }

      if (meta.name === 'scoreboard_objective') {
        if (removesDisplayedScoreboardObjective(data, sessionState)) {
          resetForScoreboardTransition()
        }
        trackScoreboardObjective(data, sessionState)
        downstream.write(meta.name, data)
        if (apolloNickname.configured) {
          refreshApolloNametags(downstream, sessionState, nicknames)
        }
        return
      }

      if (meta.name === 'scoreboard_display_objective') {
        if (scoreboardSidebarObjectiveWillChange(data, sessionState)) {
          resetForScoreboardTransition()
        }
        trackScoreboardDisplayObjective(data, sessionState)
        recoverBedWarsStateFromScoreboard()
        announceAllObsidianDetections()
        downstream.write(meta.name, data)
        if (apolloNickname.configured) {
          refreshApolloNametags(downstream, sessionState, nicknames)
        }
        return
      }

      if (meta.name === 'scoreboard_score') {
        trackScoreboardScore(data, sessionState)
        recoverBedWarsStateFromScoreboard()
        analyzeScoreboard()
        announceAllObsidianDetections()
        downstream.write(meta.name, withNicknameScoreboardScore(data, nicknames))
        if (typeof (data as any)?.itemName === 'string') {
          refreshApolloPlayers([(data as any).itemName])
        }
        return
      }

      if (meta.name === 'named_entity_spawn') {
        trackNamedEntitySpawn(data, sessionState)
        const entityId = Number((data as any)?.entityId)
        const pendingEquipment = pendingHeldItemsByEntityId.get(entityId)
        if (pendingEquipment) {
          trackEntityEquipment(pendingEquipment, sessionState)
          pendingHeldItemsByEntityId.delete(entityId)
        }
        downstream.write(meta.name, withNicknameNamedEntitySpawn(data, nicknames))
        announceObsidianHolders()
        return
      }

      if (meta.name === 'entity_metadata') {
        trackEntityMetadata(data, sessionState)
        downstream.write(meta.name, withNicknameEntityMetadata(data, nicknames))
        return
      }

      if (meta.name === 'entity_equipment') {
        const entityId = Number((data as any)?.entityId)
        if (Number((data as any)?.slot) === 0 && Number.isInteger(entityId)) {
          if (sessionState.playerEntityUuidById.has(entityId)) pendingHeldItemsByEntityId.delete(entityId)
          else pendingHeldItemsByEntityId.set(entityId, data)
        }
        trackEntityEquipment(data, sessionState)
        downstream.write(meta.name, data)
        announceObsidianHolders()
        return
      }

      if (meta.name === 'entity_destroy') {
        for (const entityId of Array.isArray((data as any)?.entityIds) ? (data as any).entityIds : []) {
          pendingHeldItemsByEntityId.delete(Number(entityId))
        }
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

    if (meta.name === 'position' || meta.name === 'position_look') {
      trackBlockHitPosition(data, blockHitSound)
    } else if (meta.name === 'block_place') {
      trackSwordBlock(data, blockHitSound)
    } else if (meta.name === 'block_dig' && Number((data as any)?.status) === 5) {
      releaseSwordBlock(blockHitSound)
    } else if (meta.name === 'held_item_slot') {
      releaseSwordBlock(blockHitSound)
    }

    if (meta.name === 'chat') {
      const message = String((data as any).message || '')
      const blockCommand = parseBlockListCommand(message)
      let blockContext: BlockedNameContext | undefined
      const targetsLocalPlayer = blockCommand?.action === 'add'
        && isLocalPlayerIdentity(sessionState, downstream.username, blockCommand.name)
      if (blockCommand?.action === 'add' && !targetsLocalPlayer) {
        const mode = currentBedWarsModeName(sessionState, splitReminderState)
        const maxPlayers = mode ? bedWarsTeamMaxPlayersFromText(mode) : MAX_BEDWARS_TEAM_PLAYERS
        const teamContext = blockedPlayerTeamContext(sessionState, blockCommand.name, maxPlayers)
        const yourTeammates = localTeammatesForBlockContext(sessionState, downstream.username, maxPlayers)
        blockContext = {
          blockedAt: new Date().toISOString(),
          teammates: teamContext.teammates,
          yourTeammates,
          ...(teamContext.team ? { team: teamContext.team } : {}),
          ...(mode ? { mode } : {}),
          ...(lastBedWarsMapName ? { map: lastBedWarsMapName } : {})
        }
      }
      if (targetsLocalPlayer) {
        if (trackBlockListCommand(blockNickHistory, `/unblock ${blockCommand.name}`)) {
          saveBlockNickHistory(blockNickHistory)
        }
      } else if (trackBlockListCommand(blockNickHistory, message, blockContext)) {
        saveBlockNickHistory(blockNickHistory)
      }
      if (message.trim() && !message.trim().startsWith('/')) {
        recentLocalChat = { message, sentAt: Date.now() }
      }

      if (/^\s*\/splitsound\s*$/i.test(message)) {
        splitSoundEventId += 1
        sendClientChat(downstream, { text: '[QoL] Split sound sent to the launcher.', color: 'yellow' })
        return
      }

      if (/^\s*\/(?:obby|obsidian)\s*$/i.test(message)) {
        if (!appConfig.bedWars.obsidianDetectorEnabled) {
          sendClientChat(downstream, {
            text: '[Obsidian] Detector is disabled. Enable it with /setting obby on.',
            color: 'yellow'
          })
          return
        }
        if (!isLiveBedWarsMatch(sessionState, splitReminderState)) {
          sendClientChat(downstream, {
            text: '[Obsidian] Available only during a live Bed Wars match.',
            color: 'gray'
          })
          return
        }
        announceAllObsidianDetections()
        const detections = obsidianHolderDetections(obsidianDetector)
        if (!detections.length) {
          sendClientChat(downstream, {
            text: '[Obsidian] No team with obsidian has been detected yet.',
            color: 'gray'
          })
          return
        }
        sendClientChat(downstream, { text: '------- Obsidian Detector -------', color: 'dark_purple' })
        for (const detection of detections) sendClientChat(downstream, obsidianDetectionChat(detection))
        return
      }

      const obsidianModeCommand = /^\s*\/(?:obby|obsidian)\s+mode(?:\s+(held|base|both))?\s*$/i.exec(message)
      if (obsidianModeCommand) {
        const requestedMode = obsidianModeCommand[1]?.toLowerCase() as 'held' | 'base' | 'both' | undefined
        if (!requestedMode) {
          sendClientChat(downstream, {
            text: `[Obsidian] Detector mode: ${appConfig.bedWars.obsidianDetectorMode}. Use /obby mode held|base|both.`,
            color: 'yellow'
          })
          return
        }
        const previousMode = appConfig.bedWars.obsidianDetectorMode
        updateAppConfig({
          ...appConfig,
          bedWars: {
            ...appConfig.bedWars,
            obsidianDetectorMode: requestedMode
          }
        })
        if (requestedMode === 'held') invalidateBedDefenseChunkQueue()
        term('Settings', `Obsidian detector mode: ${previousMode} -> ${requestedMode}.`, colors.yellow)
        sendClientChat(downstream, {
          text: `[Obsidian] Detector mode changed from ${previousMode} to ${requestedMode}.`,
          color: 'yellow'
        })
        return
      }

      const settingCommand = parseSettingCommand(message)
      if (settingCommand?.action === 'list') {
        sendClientChat(downstream, { text: '------- Local Proxy Settings -------', color: 'dark_aqua' })
        for (const setting of LOCAL_SETTING_DEFINITIONS) {
          const enabled = localSettingValue(appConfig, setting.path) === true
          sendClientChat(downstream, {
            text: '',
            extra: [
              {
                text: enabled ? 'ON ' : 'OFF ',
                color: enabled ? 'green' : 'red',
                bold: true,
                clickEvent: { action: 'run_command', value: `/setting ${setting.path}` },
                hoverEvent: { action: 'show_text', value: { text: 'Click to toggle', color: 'yellow' } }
              },
              { text: setting.displayName, color: 'yellow' },
              { text: ` (${setting.path})`, color: 'gray' }
            ]
          })
        }
        sendClientChat(downstream, {
          text: 'Click ON/OFF or use /setting <path> [on|off]',
          color: 'gray'
        })
        return
      }

      if (settingCommand?.action === 'change') {
        const change = changeLocalSetting(appConfig, settingCommand.path, settingCommand.value)
        if (!change) {
          sendClientChat(downstream, {
            text: `[Settings] Unknown setting: ${settingCommand.path}`,
            color: 'red'
          })
          sendClientChat(downstream, {
            text: '[Settings] Use /setting to list available settings.',
            color: 'yellow'
          })
          return
        }

        updateAppConfig(change.config)
        if (change.path === 'bedwars.tablist.show_respawn_timer' && !change.newValue) {
          clearActiveRespawnTimers(true)
        }
        term(
          'Settings',
          `${change.displayName}: ${change.oldValue ? 'ON' : 'OFF'} -> ${change.newValue ? 'ON' : 'OFF'}.`,
          colors.yellow
        )
        sendClientChat(downstream, {
          text: '',
          extra: [
            { text: '[Settings] Changed ', color: 'gray' },
            { text: change.displayName, color: 'yellow' },
            { text: ` from ${change.oldValue ? 'ON' : 'OFF'} to `, color: 'gray' },
            {
              text: change.newValue ? 'ON' : 'OFF',
              color: change.newValue ? 'green' : 'red',
              bold: true
            },
            { text: '.', color: 'gray' }
          ]
        })
        return
      }

      if (settingCommand?.action === 'help') {
        sendClientChat(downstream, {
          text: '[Settings] Usage: /setting <path> [on|off]',
          color: 'yellow'
        })
        sendClientChat(downstream, {
          text: '[Settings] Leave out on/off to toggle. Use /setting to list settings.',
          color: 'gray'
        })
        return
      }

      const nicknameCommand = parseNicknameCommand(message)
      if (nicknameCommand?.action === 'list') {
        const list = nicknameListPage(nicknames, nicknameCommand.page)
        for (const component of list.components) sendClientChat(downstream, component)
        return
      }

      if (nicknameCommand?.action === 'remove') {
        const key = nicknameCommand.player.toLowerCase()
        if (nicknames.delete(key)) {
          saveNicknames(nicknames)
          refreshLocalNicknames(downstream, sessionState, nicknames, nicknameCommand.player)
          if (apolloNickname.configured) {
            refreshApolloNametags(downstream, sessionState, nicknames, undefined, true)
          }
          sendClientChat(downstream, okChat(`Tog bort nickname for ${nicknameCommand.player}.`))
        } else {
          sendClientChat(downstream, infoChat(`${nicknameCommand.player} hade ingen nickname.`))
        }
        return
      }

      if (nicknameCommand?.action === 'add') {
        const cleanedNickname = stripColors(nicknameCommand.nickname).trim()
        if (!cleanedNickname || cleanedNickname.length > 32) {
          sendClientChat(downstream, errChat('Usage: /nickname add <player> <nickname> (max 32 tecken)'))
          return
        }

        nicknames.set(nicknameCommand.player.toLowerCase(), cleanedNickname)
        saveNicknames(nicknames)
        refreshLocalNicknames(downstream, sessionState, nicknames, nicknameCommand.player)
        if (apolloNickname.configured) {
          refreshApolloNametags(downstream, sessionState, nicknames, nicknameCommand.player)
        }
        sendClientChat(downstream, okChat(`${nicknameCommand.player} visas lokalt som ${cleanedNickname}.`))
        return
      }

      if (nicknameCommand?.action === 'help') {
        sendClientChat(downstream, infoChat('Usage: /nickname <add|remove|list> [player] [nickname]'))
        sendClientChat(downstream, infoChat('Short add: /n <player> <nickname>'))
        sendClientChat(downstream, infoChat('Short remove/list: /nr <player> | /nl [page]'))
        sendClientChat(downstream, infoChat('Also supported: /n <a|r|l> ...'))
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

  return () => {
    bridgeClosed = true
    invalidateBedDefenseChunkQueue()
    clearInterval(respawnTimerInterval)
    clearRespawnTimers(respawnTimers)
    pendingRespawnDisconnectChecks.clear()
    respawnProfilesByPlayerKey.clear()
    syntheticRespawnPlayers.clear()
    pendingHeldItemsByEntityId.clear()
    resetBlockHitSoundState(blockHitSound)
    resetObsidianDetectorState(obsidianDetector)
    resetBedDefenseState(bedDefense)
    activeBlockHitSoundTests.delete(testThisSessionBlockHitSound)
  }
}

export const __test = {
  createSplitReminderState,
  createSessionState,
  cleanWindowTitle,
  deathPlayerName,
  respawnDeathPlayerName,
  reconnectedPlayerName,
  disconnectedWhileRespawningPlayerName,
  bedWarsTeamColorFromChatComponent,
  bedWarsMapNameFromScoreboard,
  activeBedWarsTeamColors,
  isBedDefenseScoreboardContext,
  obsidianHoldersFromSession,
  blockedPlayerTeamContext,
  localTeammatesForBlockContext,
  currentBedWarsModeName,
  offlinePlayerUuid,
  isLocalTeammateDeathText,
  isLobbySelectorWindowTitle,
  localPlayerAliasFromChatEcho,
  localPlayerAliasFromNickStatus,
  lobbyCommandKey,
  lobbyWindowClickKey,
  legacyFormattedComponent,
  localPlayerNametagComponent,
  localPlayerNametagLines,
  localRespawnPlayerName,
  localPlayerTeam,
  localTeammateNames,
  nicknameListPage,
  parseNicknameCommand,
  parseSettingCommand,
  canonicalSettingPath,
  localSettingValue,
  changeLocalSetting,
  playerInfoMayChangeBedWarsRoster,
  shouldExtendTransferWatchFromChunk,
  refreshApolloNametags,
  refreshNicknameTabPlayers,
  refreshLocalNicknames,
  replaceNamesInChat,
  registerLocalPlayerAlias,
  serverListDescription,
  serverListPlayers,
  serverListStatusResponse,
  trackNamedEntitySpawn,
  trackLocalGameMode,
  trackPlayerInfo,
  trackScoreboardTeam,
  trackScoreboardObjective,
  trackScoreboardDisplayObjective,
  trackScoreboardScore,
  updateBedWarsModeFromScoreboard,
  restoreBedWarsGameStateFromScoreboard,
  isActiveBedWarsMatchScoreboardText,
  scoreboardSidebarObjectiveWillChange,
  removesDisplayedScoreboardObjective,
  isLiveBedWarsMatch,
  withSplitReminderChatComponent,
  withSplitReminderPacket,
  withSplitReminderUnknownPacket,
  forcedSplitTitlePacket,
  packetHasRespawnedTitleText,
  packetHasLocalDeathTitleText,
  localRespawnCountdownSeconds,
  splitTitleSubtitlePacket,
  splitTitleTimingPacket,
  shouldRawForwardUpstreamPacket,
  withNicknameEntityMetadata,
  withNicknameNamedEntitySpawn,
  withNicknamePlayerInfo,
  respawnTimerDisplayName,
  respawnTimerPlayerSnapshot,
  respawnTabRemovePacket,
  respawnTabAddPacket,
  respawnTabDisplayPacket,
  withNicknameScoreboardScore,
  withNicknameScoreboardTeam,
  withRespawningPlayersKeptInTeam
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
    getBlockHitSoundStatus: blockHitSoundStatus,
    setRoute,
    setSplitReminderEnabled,
    setBlockHitSoundEnabled,
    setBlockHitSoundVolume,
    testBlockHitSound,
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
    let diagnosticSessionState: SessionState | null = null
    const closeSessionCounter = () => {
      if (!countedSession) return
      countedSession = false
      activeSessions = Math.max(0, activeSessions - 1)
      if (diagnosticSessionState) activeSessionStates.delete(diagnosticSessionState)
    }
    term('Local', `${downstream.username} is logging in from ${remoteHost}:${remotePort} using Hypixel Proxy`, colors.magenta)
    term('Routing', `${downstream.username} -> ${route.name} (${route.host}:${route.port})`, colors.cyan)

    const nicknames = loadNicknames()
    const sessionState = createSessionState(downstream.username, downstream.uuid)
    diagnosticSessionState = sessionState
    activeSessionStates.add(sessionState)
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
    let cleanupPlayBridge = () => {}

    const keepMicrosoftAuthRunning = (why: string) => {
      if (localClosed) return
      localClosed = true
      cleanupPlayBridge()
      closeSessionCounter()
      detachedAuth = true
      logSessionClosed(`${why}; Microsoft sign-in is still running`)
      term('Microsoft', `Complete the browser sign-in, wait for confirmation here, then join ${LOCAL_ADDRESS} again.`, colors.yellow)
    }

    const closeBoth = (why: string) => {
      if (localClosed) return
      localClosed = true
      cleanupPlayBridge()
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
    cleanupPlayBridge = bridgePlay(upstream, downstream, nicknames, sessionState, splitReminderState)

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
