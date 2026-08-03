const SWORD_ITEM_IDS = new Set([267, 268, 272, 276, 283])
const DAMAGE_SIGNAL_DEDUPE_MS = 250
const BLOCK_RELEASE_GRACE_MS = 300

export type BlockHitPosition = {
  x: number
  y: number
  z: number
}

export type BlockHitSoundState = {
  blockingWithSword: boolean
  lastBlockReleasedAt: number
  localEntityId: number | null
  lastHealth: number | null
  lastSoundAt: number
  position: BlockHitPosition | null
}

export function createBlockHitSoundState(): BlockHitSoundState {
  return {
    blockingWithSword: false,
    lastBlockReleasedAt: 0,
    localEntityId: null,
    lastHealth: null,
    lastSoundAt: 0,
    position: null
  }
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function trackBlockHitLocalEntity(packet: any, state: BlockHitSoundState) {
  const entityId = finiteNumber(packet?.entityId)
  if (entityId !== null) state.localEntityId = entityId
}

export function trackBlockHitPosition(packet: any, state: BlockHitSoundState) {
  const x = finiteNumber(packet?.x)
  const y = finiteNumber(packet?.y)
  const z = finiteNumber(packet?.z)
  if (x === null || y === null || z === null) return
  state.position = { x, y, z }
}

export function trackSwordBlock(packet: any, state: BlockHitSoundState): boolean {
  const direction = finiteNumber(packet?.direction)
  const itemId = finiteNumber(packet?.heldItem?.blockId)
  const usesHeldItem = direction === -1 || direction === 255
  state.blockingWithSword = usesHeldItem && itemId !== null && SWORD_ITEM_IDS.has(itemId)
  if (state.blockingWithSword) state.lastBlockReleasedAt = 0
  return state.blockingWithSword
}

export function releaseSwordBlock(state: BlockHitSoundState, now = Date.now()) {
  if (state.blockingWithSword) state.lastBlockReleasedAt = now
  state.blockingWithSword = false
}

export function resetBlockHitSoundState(state: BlockHitSoundState) {
  state.blockingWithSword = false
  state.lastBlockReleasedAt = 0
  state.lastHealth = null
  state.lastSoundAt = 0
  state.position = null
}

function confirmBlockedDamage(state: BlockHitSoundState, now: number): boolean {
  const justReleased = state.lastBlockReleasedAt > 0 && now - state.lastBlockReleasedAt <= BLOCK_RELEASE_GRACE_MS
  if (!state.blockingWithSword && !justReleased) return false
  if (now - state.lastSoundAt < DAMAGE_SIGNAL_DEDUPE_MS) return false
  state.lastSoundAt = now
  return true
}

export function observeBlockHitHealth(packet: any, state: BlockHitSoundState, now = Date.now()): boolean {
  const health = finiteNumber(packet?.health)
  if (health === null) return false
  const previousHealth = state.lastHealth
  state.lastHealth = health
  return previousHealth !== null && health < previousHealth && confirmBlockedDamage(state, now)
}

export function observeBlockHitEntityStatus(packet: any, state: BlockHitSoundState, now = Date.now()): boolean {
  const entityId = finiteNumber(packet?.entityId)
  const entityStatus = finiteNumber(packet?.entityStatus)
  if (state.localEntityId === null || entityId !== state.localEntityId || entityStatus !== 2) return false
  return confirmBlockedDamage(state, now)
}

export function blockHitSoundPacket(state: BlockHitSoundState, volume = 0.5): any | null {
  if (!state.position) return null
  return {
    soundName: 'mob.irongolem.hit',
    x: Math.floor(state.position.x * 8),
    y: Math.floor(state.position.y * 8),
    z: Math.floor(state.position.z * 8),
    volume: Math.max(0, Math.min(1, volume)),
    pitch: 63
  }
}

export const __test = {
  SWORD_ITEM_IDS,
  DAMAGE_SIGNAL_DEDUPE_MS,
  BLOCK_RELEASE_GRACE_MS
}
