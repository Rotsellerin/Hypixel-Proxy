import fs from 'fs'
import path from 'path'

export type RouteId = 'direct' | 'stopthelag'

export type UpstreamRoute = {
  id: RouteId
  name: string
  host: string
  port: number
  description: string
}

export type SplitReminderSettings = {
  enabled: boolean
  respawnedText: string
  replacementText: string
  localDeathPatterns: string[]
  teammateDeathPatterns: string[]
}

export type AppConfig = {
  routeId: RouteId
  splitReminder: SplitReminderSettings
}

export const DEFAULT_SPLIT_REMINDER: SplitReminderSettings = {
  enabled: true,
  respawnedText: 'RESPAWNED',
  replacementText: 'SPLIT',
  localDeathPatterns: [
    '\\byou died\\b',
    '\\byou are dead\\b',
    '\\byou (?:fell|fall) (?:in|into|out of) (?:the )?(?:void|world)\\b',
    '\\byou (?:were|got) (?:knocked|thrown|pushed) (?:in|into|off|out of) (?:the )?(?:void|world|map|cliff)\\b',
    '\\byou will respawn in\\b',
    '\\brespawn(?:ing)? in\\b'
  ],
  teammateDeathPatterns: [
    '\\bdied\\b',
    '\\bwas killed\\b',
    '\\bwas slain by\\b',
    '\\bwas shot by\\b',
    '\\bfell (?:in|into|out of) (?:the )?(?:void|world)\\b',
    '\\bwas (?:knocked|thrown|pushed) (?:in|into|off|out of) (?:the )?(?:void|world|map|cliff)\\b'
  ]
}

export function createRouteCatalog(
  directHost = 'mc.hypixel.net',
  directPort = 25565,
  stopTheLagHost = 'chi1.qtx.stopthelag.lol',
  stopTheLagPort = 25566
): UpstreamRoute[] {
  return [
    {
      id: 'direct',
      name: 'Direct',
      host: directHost,
      port: directPort,
      description: 'Minecraft proxy -> Hypixel'
    },
    {
      id: 'stopthelag',
      name: 'StopTheLag',
      host: stopTheLagHost,
      port: stopTheLagPort,
      description: 'Minecraft proxy -> StopTheLag -> Hypixel'
    }
  ]
}

export function defaultAppConfig(): AppConfig {
  return {
    routeId: 'direct',
    splitReminder: { ...DEFAULT_SPLIT_REMINDER }
  }
}

export function appConfigPath(stateDir: string): string {
  return path.join(stateDir, 'app-config.json')
}

export function normalizeRouteId(value: unknown): RouteId {
  return value === 'stopthelag' ? 'stopthelag' : 'direct'
}

export function routeById(routeId: unknown, routes: UpstreamRoute[]): UpstreamRoute {
  const normalized = normalizeRouteId(routeId)
  return routes.find(route => route.id === normalized) || routes[0]
}

function cleanPatternList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const next = value
    .filter(item => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean)
  return Array.from(new Set(next))
}

function mergePatternList(value: unknown, fallback: string[]): string[] {
  const next = cleanPatternList(value)
  for (const pattern of fallback) {
    if (!next.includes(pattern)) next.push(pattern)
  }
  return next.length ? next : fallback.slice()
}

export function normalizeSplitReminderSettings(value: unknown): SplitReminderSettings {
  const fallback = DEFAULT_SPLIT_REMINDER
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}

  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : fallback.enabled,
    respawnedText: typeof raw.respawnedText === 'string' && raw.respawnedText.trim()
      ? raw.respawnedText.trim()
      : fallback.respawnedText,
    replacementText: typeof raw.replacementText === 'string' && raw.replacementText.trim()
      ? raw.replacementText.trim()
      : fallback.replacementText,
    localDeathPatterns: mergePatternList(raw.localDeathPatterns, fallback.localDeathPatterns),
    teammateDeathPatterns: mergePatternList(raw.teammateDeathPatterns, fallback.teammateDeathPatterns)
  }
}

export function normalizeAppConfig(value: unknown): AppConfig {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    routeId: normalizeRouteId(raw.routeId),
    splitReminder: normalizeSplitReminderSettings(raw.splitReminder)
  }
}

export function loadAppConfig(stateDir: string): AppConfig {
  const filePath = appConfigPath(stateDir)
  if (!fs.existsSync(filePath)) return defaultAppConfig()

  try {
    return normalizeAppConfig(JSON.parse(fs.readFileSync(filePath, 'utf8')))
  } catch {
    return defaultAppConfig()
  }
}

export function saveAppConfig(stateDir: string, config: AppConfig): AppConfig {
  fs.mkdirSync(stateDir, { recursive: true })
  const normalized = normalizeAppConfig(config)
  const filePath = appConfigPath(stateDir)
  const tmp = filePath + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2))
  fs.renameSync(tmp, filePath)
  return normalized
}
