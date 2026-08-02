export type BlockListSnapshot = Record<string, string>

export type BlockedNameContext = {
  blockedAt: string
  teammates: string[]
  yourTeammates?: string[]
  team?: string
  mode?: string
  map?: string
}

export type BlockNickHistoryFile = {
  version: 2
  trackedBlockedNames: Record<string, string>
  aliasesByCurrentName: Record<string, string[]>
  snapshotsByPage: Record<string, BlockListSnapshot>
  contextsByBlockedName: Record<string, BlockedNameContext>
}

export type BlockNickHistoryState = {
  trackedBlockedNames: Map<string, string>
  aliasesByCurrentName: Map<string, Set<string>>
  snapshotsByPage: Map<number, BlockListSnapshot>
  contextsByBlockedName: Map<string, BlockedNameContext>
  capture: {
    page: number
    previous: BlockListSnapshot
    current: BlockListSnapshot
    expiresAt: number
  } | null
}

export type BlockListCommand =
  | { action: 'add' | 'remove'; name: string }
  | { action: 'clear' }

export type BlockListObservation = {
  component: any
  changed: boolean
  learned: { currentName: string; previousNames: string[] } | null
}

const PLAYER_NAME = '[A-Za-z0-9_]{1,16}'

function playerKey(name: string): string {
  return name.trim().toLowerCase()
}

function validPlayerName(name: string): boolean {
  return /^[A-Za-z0-9_]{1,16}$/.test(name)
}

function stripColors(text: string): string {
  return text.replace(/\u00a7[0-9A-FK-ORa-fk-or]/g, '')
}

function flattenComponent(component: any): string {
  if (component == null) return ''
  if (typeof component === 'string') {
    try {
      return flattenComponent(JSON.parse(component))
    } catch {
      return component
    }
  }
  if (typeof component === 'number' || typeof component === 'boolean') return String(component)
  if (Array.isArray(component)) return component.map(flattenComponent).join('')
  if (typeof component !== 'object') return ''

  let text = typeof component.text === 'string' ? component.text : ''
  if (Array.isArray(component.extra)) text += component.extra.map(flattenComponent).join('')
  if (Array.isArray(component.with)) text += component.with.map(flattenComponent).join('')
  return text
}

function blockListHeader(text: string): { page: number; totalPages: number } | null {
  const clean = stripColors(text).replace(/\s+/g, ' ').trim()
  const match = /Blocked Players\s*\(Page\s+(\d+)\s+of\s+(\d+)\)/i.exec(clean)
  if (!match) return null
  const page = Number(match[1])
  const totalPages = Number(match[2])
  if (!Number.isInteger(page) || !Number.isInteger(totalPages) || page < 1 || totalPages < page) return null
  return { page, totalPages }
}

function blockListRow(text: string): { row: number; name: string } | null {
  const clean = stripColors(text).replace(/\s+/g, ' ').trim()
  const match = new RegExp(`^(\\d+)\\.\\s*(${PLAYER_NAME})$`, 'i').exec(clean)
  if (!match) return null
  const row = Number(match[1])
  if (!Number.isInteger(row) || row < 1) return null
  return { row, name: match[2] }
}

function displayBlockedAt(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return value
  const pad = (number: number) => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function hoverValue(
  previousNames: string[],
  contextsByBlockedName: Map<string, BlockedNameContext>
): any {
  const extra: any[] = []
  previousNames.forEach((name, index) => {
    if (index) extra.push({ text: '\n\n' })
    extra.push({ text: 'Blocked nickname:', color: 'gray' })
    extra.push({ text: ` ${name}`, color: 'yellow' })

    const context = contextsByBlockedName.get(playerKey(name))
    if (!context) return
    if (context.teammates.length) {
      extra.push({ text: '\nTeammates: ', color: 'gray' })
      extra.push({ text: context.teammates.join(', '), color: 'aqua' })
    }
    if (context.yourTeammates?.length) {
      extra.push({ text: '\nYour teammates: ', color: 'gray' })
      extra.push({ text: context.yourTeammates.join(', '), color: 'green' })
    }
    if (context.team) {
      extra.push({ text: '\nTeam: ', color: 'gray' })
      extra.push({ text: context.team, color: 'white' })
    }
    if (context.mode) {
      extra.push({ text: '\nMode: ', color: 'gray' })
      extra.push({ text: context.mode, color: 'white' })
    }
    if (context.map) {
      extra.push({ text: '\nMap: ', color: 'gray' })
      extra.push({ text: context.map, color: 'white' })
    }
    if (context.blockedAt) {
      extra.push({ text: '\nBlocked: ', color: 'gray' })
      extra.push({ text: displayBlockedAt(context.blockedAt), color: 'white' })
    }
  })
  return { text: '', extra }
}

function combinedHoverValue(
  existing: any,
  previousNames: string[],
  contextsByBlockedName: Map<string, BlockedNameContext>
): any {
  if (existing == null) return hoverValue(previousNames, contextsByBlockedName)
  return {
    text: '',
    extra: [
      existing,
      { text: '\n' },
      hoverValue(previousNames, contextsByBlockedName)
    ]
  }
}

function addHoverToName(
  component: any,
  playerName: string,
  previousNames: string[],
  contextsByBlockedName: Map<string, BlockedNameContext>
): [any, boolean] {
  if (typeof component === 'string') {
    const expression = new RegExp(`\\b${playerName.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`, 'i')
    if (!expression.test(component)) return [component, false]
    return [{ text: component, hoverEvent: { action: 'show_text', value: hoverValue(previousNames, contextsByBlockedName) } }, true]
  }
  if (Array.isArray(component)) {
    let applied = false
    const copy = component.map(item => {
      if (applied) return item
      const [updated, itemApplied] = addHoverToName(item, playerName, previousNames, contextsByBlockedName)
      applied = itemApplied
      return updated
    })
    return [copy, applied]
  }
  if (!component || typeof component !== 'object') return [component, false]

  const copy: any = { ...component }
  if (typeof copy.text === 'string') {
    const expression = new RegExp(`\\b${playerName.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`, 'i')
    if (expression.test(copy.text)) {
      copy.hoverEvent = {
        action: 'show_text',
        value: combinedHoverValue(copy.hoverEvent?.value, previousNames, contextsByBlockedName)
      }
      return [copy, true]
    }
  }

  for (const field of ['extra', 'with']) {
    if (!Array.isArray(copy[field])) continue
    let applied = false
    copy[field] = copy[field].map((item: any) => {
      if (applied) return item
      const [updated, itemApplied] = addHoverToName(item, playerName, previousNames, contextsByBlockedName)
      applied = itemApplied
      return updated
    })
    if (applied) return [copy, true]
  }

  return [copy, false]
}

function withBlockedNameHover(
  component: any,
  currentName: string,
  previousNames: string[],
  contextsByBlockedName: Map<string, BlockedNameContext>
): any {
  const [updated, applied] = addHoverToName(component, currentName, previousNames, contextsByBlockedName)
  if (applied) return updated
  if (!updated || typeof updated !== 'object' || Array.isArray(updated)) {
    return {
      text: flattenComponent(updated),
      hoverEvent: { action: 'show_text', value: hoverValue(previousNames, contextsByBlockedName) }
    }
  }
  return {
    ...updated,
    hoverEvent: {
      action: 'show_text',
      value: combinedHoverValue(updated.hoverEvent?.value, previousNames, contextsByBlockedName)
    }
  }
}

export function createBlockNickHistoryState(file?: Partial<BlockNickHistoryFile> | null): BlockNickHistoryState {
  const state: BlockNickHistoryState = {
    trackedBlockedNames: new Map(),
    aliasesByCurrentName: new Map(),
    snapshotsByPage: new Map(),
    contextsByBlockedName: new Map(),
    capture: null
  }

  for (const [key, name] of Object.entries(file?.trackedBlockedNames || {})) {
    if (validPlayerName(name)) state.trackedBlockedNames.set(playerKey(key), name)
  }
  for (const [key, names] of Object.entries(file?.aliasesByCurrentName || {})) {
    if (!Array.isArray(names)) continue
    const validNames = names.filter((name): name is string => typeof name === 'string' && validPlayerName(name))
    if (validNames.length) state.aliasesByCurrentName.set(playerKey(key), new Set(validNames))
  }
  for (const [pageValue, snapshot] of Object.entries(file?.snapshotsByPage || {})) {
    const page = Number(pageValue)
    if (!Number.isInteger(page) || page < 1 || !snapshot || typeof snapshot !== 'object') continue
    const cleanSnapshot: BlockListSnapshot = {}
    for (const [row, name] of Object.entries(snapshot)) {
      if (/^\d+$/.test(row) && validPlayerName(name)) cleanSnapshot[row] = name
    }
    state.snapshotsByPage.set(page, cleanSnapshot)
  }
  for (const [key, context] of Object.entries(file?.contextsByBlockedName || {})) {
    if (!context || typeof context !== 'object') continue
    const blockedAt = typeof context.blockedAt === 'string' ? context.blockedAt.trim() : ''
    const teammates = Array.isArray(context.teammates)
      ? Array.from(new Set(context.teammates.filter((name): name is string => typeof name === 'string' && validPlayerName(name))))
      : []
    const clean: BlockedNameContext = { blockedAt, teammates }
    if (Array.isArray(context.yourTeammates)) {
      clean.yourTeammates = Array.from(new Set(
        context.yourTeammates.filter((name): name is string => typeof name === 'string' && validPlayerName(name))
      ))
    }
    if (typeof context.team === 'string' && context.team.trim()) clean.team = context.team.trim()
    if (typeof context.mode === 'string' && context.mode.trim()) clean.mode = context.mode.trim()
    if (typeof context.map === 'string' && context.map.trim()) clean.map = context.map.trim()
    state.contextsByBlockedName.set(playerKey(key), clean)
  }
  return state
}

export function serializeBlockNickHistory(state: BlockNickHistoryState): BlockNickHistoryFile {
  const trackedBlockedNames: Record<string, string> = {}
  const aliasesByCurrentName: Record<string, string[]> = {}
  const snapshotsByPage: Record<string, BlockListSnapshot> = {}
  const contextsByBlockedName: Record<string, BlockedNameContext> = {}

  for (const [key, name] of Array.from(state.trackedBlockedNames.entries()).sort()) {
    trackedBlockedNames[key] = name
  }
  for (const [key, names] of Array.from(state.aliasesByCurrentName.entries()).sort()) {
    aliasesByCurrentName[key] = Array.from(names).sort((left, right) => left.localeCompare(right))
  }
  for (const [page, snapshot] of Array.from(state.snapshotsByPage.entries()).sort(([left], [right]) => left - right)) {
    snapshotsByPage[String(page)] = { ...snapshot }
  }
  for (const [key, context] of Array.from(state.contextsByBlockedName.entries()).sort()) {
    contextsByBlockedName[key] = {
      ...context,
      teammates: [...context.teammates],
      ...(context.yourTeammates ? { yourTeammates: [...context.yourTeammates] } : {})
    }
  }

  return { version: 2, trackedBlockedNames, aliasesByCurrentName, snapshotsByPage, contextsByBlockedName }
}

export function parseBlockListCommand(message: string): BlockListCommand | null {
  if (/^\s*\/(?:block|ignore)\s+(?:clear|removeall)\s*$/i.test(message)) return { action: 'clear' }
  const add = /^\s*\/(?:block(?:\s+add)?|ignore\s+add)\s+([A-Za-z0-9_]{1,16})\s*$/i.exec(message)
  const remove = /^\s*\/(?:unblock|ignore\s+remove|block\s+remove)\s+([A-Za-z0-9_]{1,16})\s*$/i.exec(message)
  if (add && /^(?:add|clear|help|list|remove|removeall)$/i.test(add[1])) return null
  if (add) return { action: 'add', name: add[1] }
  if (remove) return { action: 'remove', name: remove[1] }
  return null
}

export function trackBlockListCommand(
  state: BlockNickHistoryState,
  message: string,
  context?: BlockedNameContext
): boolean {
  const command = parseBlockListCommand(message)
  if (!command) return false

  state.capture = null
  state.snapshotsByPage.clear()
  if (command.action === 'clear') {
    state.trackedBlockedNames.clear()
    state.aliasesByCurrentName.clear()
    state.contextsByBlockedName.clear()
    return true
  }

  const key = playerKey(command.name)
  if (command.action === 'add') {
    state.trackedBlockedNames.set(key, command.name)
    if (context) {
      const previous = state.contextsByBlockedName.get(key)
      const yourTeammates = context.yourTeammates?.length
        ? context.yourTeammates
        : previous?.yourTeammates || []
      const nextContext: BlockedNameContext = {
        ...previous,
        ...context,
        teammates: context.teammates.length ? context.teammates : previous?.teammates || []
      }
      if (yourTeammates.length) nextContext.yourTeammates = yourTeammates
      else delete nextContext.yourTeammates
      state.contextsByBlockedName.set(key, nextContext)
    }
  } else {
    const previousNames = state.aliasesByCurrentName.get(key)
    if (previousNames) {
      for (const previousName of previousNames) {
        state.trackedBlockedNames.delete(playerKey(previousName))
        state.contextsByBlockedName.delete(playerKey(previousName))
      }
    }
    state.trackedBlockedNames.delete(key)
    state.aliasesByCurrentName.delete(key)
    state.contextsByBlockedName.delete(key)
  }
  return true
}

export function observeBlockListChat(
  state: BlockNickHistoryState,
  component: any,
  now = Date.now()
): BlockListObservation {
  const text = flattenComponent(component)
  const header = blockListHeader(text)
  if (header) {
    state.capture = {
      page: header.page,
      previous: { ...(state.snapshotsByPage.get(header.page) || {}) },
      current: {},
      expiresAt: now + 10_000
    }
    return { component, changed: false, learned: null }
  }

  const row = blockListRow(text)
  const capture = state.capture
  if (!row || !capture || now > capture.expiresAt) {
    if (capture && now > capture.expiresAt) state.capture = null
    return { component, changed: false, learned: null }
  }

  capture.expiresAt = now + 10_000
  const rowKey = String(row.row)
  const previousName = capture.previous[rowKey]
  const previousNames = new Set<string>(state.aliasesByCurrentName.get(playerKey(row.name)) || [])
  let learned: BlockListObservation['learned'] = null

  if (previousName && playerKey(previousName) !== playerKey(row.name)) {
    const inheritedNames = state.aliasesByCurrentName.get(playerKey(previousName))
    if (inheritedNames) {
      for (const name of inheritedNames) previousNames.add(name)
    }
    const trackedName = state.trackedBlockedNames.get(playerKey(previousName))
    if (trackedName) previousNames.add(trackedName)

    if (previousNames.size) {
      previousNames.delete(row.name)
      state.aliasesByCurrentName.set(playerKey(row.name), previousNames)
      learned = { currentName: row.name, previousNames: Array.from(previousNames) }
    }
  }

  capture.current[rowKey] = row.name
  state.snapshotsByPage.set(capture.page, { ...capture.current })

  const knownPreviousNames = Array.from(state.aliasesByCurrentName.get(playerKey(row.name)) || [])
    .filter(name => playerKey(name) !== playerKey(row.name))
  const hoverNames = new Set(knownPreviousNames)
  const trackedName = state.trackedBlockedNames.get(playerKey(row.name))
  if (trackedName && state.contextsByBlockedName.has(playerKey(trackedName))) hoverNames.add(trackedName)
  return {
    component: hoverNames.size
      ? withBlockedNameHover(component, row.name, Array.from(hoverNames), state.contextsByBlockedName)
      : component,
    changed: true,
    learned
  }
}

export const __test = {
  blockListHeader,
  blockListRow,
  flattenComponent,
  withBlockedNameHover
}
