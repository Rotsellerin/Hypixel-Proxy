import { BedWarsTeamColor } from './obsidianDetectorState'

type BlockPosition = { x: number; y: number; z: number }
type RelevantBlock = BlockPosition & { id: number; metadata: number }

export type BedDefenseChunkPacket = {
  x: number
  z: number
  bitMap: number
  chunkData: Buffer
}

export type BedDefenseDetection = {
  team: BedWarsTeamColor
  bed: BlockPosition
  obsidianBlocks: number
}

export type BedDefenseState = {
  blocks: Map<string, RelevantBlock>
  changedBlockKeys: Set<string>
  teamByBedKey: Map<string, BedWarsTeamColor>
}

const BED_BLOCK_ID = 26
const OBSIDIAN_BLOCK_ID = 49
const TEAM_MARKER_BLOCK_IDS = new Set([35])

const TEAM_BY_COLOR_METADATA: Partial<Record<number, BedWarsTeamColor>> = {
  0: 'White',
  3: 'Aqua',
  4: 'Yellow',
  5: 'Green',
  6: 'Pink',
  7: 'Gray',
  9: 'Aqua',
  11: 'Blue',
  13: 'Green',
  14: 'Red'
}

function positionKey(position: BlockPosition): string {
  return `${position.x},${position.y},${position.z}`
}

function sectionCount(bitMap: number): number {
  let count = 0
  for (let section = 0; section < 16; section += 1) {
    if ((bitMap & (1 << section)) !== 0) count += 1
  }
  return count
}

function relevantBlock(id: number): boolean {
  return id === BED_BLOCK_ID || id === OBSIDIAN_BLOCK_ID || TEAM_MARKER_BLOCK_IDS.has(id)
}

function setBlock(state: BedDefenseState, position: BlockPosition, blockStateId: number) {
  const id = blockStateId >> 4
  const key = positionKey(position)
  if (!relevantBlock(id)) {
    state.blocks.delete(key)
    return
  }
  state.blocks.set(key, { ...position, id, metadata: blockStateId & 15 })
}

function setChangedBlock(state: BedDefenseState, position: BlockPosition, blockStateId: number) {
  const key = positionKey(position)
  // A queued chunk may be analyzed after a newer block-change packet. Keep
  // the live update authoritative so deferred scanning cannot roll it back.
  state.changedBlockKeys.add(key)
  setBlock(state, position, blockStateId)
}

function clearChunkSections(state: BedDefenseState, chunkX: number, chunkZ: number, bitMap: number) {
  for (const [key, block] of state.blocks) {
    if ((block.x >> 4) !== chunkX || (block.z >> 4) !== chunkZ) continue
    if ((bitMap & (1 << (block.y >> 4))) !== 0 && !state.changedBlockKeys.has(key)) state.blocks.delete(key)
  }
}

function scanChunk(
  state: BedDefenseState,
  chunkX: number,
  chunkZ: number,
  bitMap: number,
  data: Buffer
): boolean {
  const sections = sectionCount(bitMap)
  const blockBytes = sections * 4096 * 2
  if (!Number.isInteger(chunkX) || !Number.isInteger(chunkZ) || data.length < blockBytes) return false

  clearChunkSections(state, chunkX, chunkZ, bitMap)
  let sectionDataOffset = 0
  for (let sectionY = 0; sectionY < 16; sectionY += 1) {
    if ((bitMap & (1 << sectionY)) === 0) continue
    for (let index = 0; index < 4096; index += 1) {
      const blockStateId = data.readUInt16LE(sectionDataOffset + index * 2)
      const id = blockStateId >> 4
      if (!relevantBlock(id)) continue
      const position = {
        x: chunkX * 16 + (index & 15),
        y: sectionY * 16 + ((index >> 8) & 15),
        z: chunkZ * 16 + ((index >> 4) & 15)
      }
      if (!state.changedBlockKeys.has(positionKey(position))) setBlock(state, position, blockStateId)
    }
    sectionDataOffset += 4096 * 2
  }
  return true
}

export function createBedDefenseState(): BedDefenseState {
  return {
    blocks: new Map(),
    changedBlockKeys: new Set(),
    teamByBedKey: new Map()
  }
}

export function resetBedDefenseState(state: BedDefenseState) {
  state.blocks.clear()
  state.changedBlockKeys.clear()
  state.teamByBedKey.clear()
}

export function clearBedDefenseObsidian(state: BedDefenseState) {
  for (const [key, block] of state.blocks) {
    if (block.id !== OBSIDIAN_BLOCK_ID) continue
    state.blocks.delete(key)
    state.changedBlockKeys.delete(key)
  }
}

export function observeBedDefenseChunk(packet: any, state: BedDefenseState): boolean {
  const data = packet?.chunkData
  if (!Buffer.isBuffer(data)) return false
  return scanChunk(state, Number(packet.x), Number(packet.z), Number(packet.bitMap), data)
}

export function bedDefenseBulkChunks(packet: any): BedDefenseChunkPacket[] {
  const data = packet?.data
  const chunks = Array.isArray(packet?.meta) ? packet.meta : []
  if (!Buffer.isBuffer(data) || !chunks.length) return []

  const skyLightSent = packet.skyLightSent === true
  const packets: BedDefenseChunkPacket[] = []
  let offset = 0
  for (const chunk of chunks) {
    const bitMap = Number(chunk?.bitMap) || 0
    const sections = sectionCount(bitMap)
    const blockBytes = sections * 8192
    const chunkLength = blockBytes + sections * (2048 + (skyLightSent ? 2048 : 0)) + 256
    if (offset + chunkLength > data.length) break
    packets.push({
      x: Number(chunk.x),
      z: Number(chunk.z),
      bitMap,
      chunkData: data.subarray(offset, offset + blockBytes)
    })
    offset += chunkLength
  }
  return packets
}

export function observeBedDefenseBulk(packet: any, state: BedDefenseState): number {
  let observed = 0
  for (const chunk of bedDefenseBulkChunks(packet)) {
    if (observeBedDefenseChunk(chunk, state)) observed += 1
  }
  return observed
}

export function observeBedDefenseBlockChange(packet: any, state: BedDefenseState): boolean {
  const location = packet?.location
  if (![location?.x, location?.y, location?.z, packet?.type].every(Number.isFinite)) return false
  setChangedBlock(state, { x: Number(location.x), y: Number(location.y), z: Number(location.z) }, Number(packet.type))
  return true
}

export function observeBedDefenseMultiBlockChange(packet: any, state: BedDefenseState): number {
  const chunkX = Number(packet?.chunkX)
  const chunkZ = Number(packet?.chunkZ)
  const records = Array.isArray(packet?.records) ? packet.records : []
  if (!Number.isFinite(chunkX) || !Number.isFinite(chunkZ)) return 0
  let observed = 0
  for (const record of records) {
    const horizontal = Number(record?.horizontalPos)
    const y = Number(record?.y)
    const blockId = Number(record?.blockId)
    if (![horizontal, y, blockId].every(Number.isFinite)) continue
    setChangedBlock(state, {
      x: chunkX * 16 + ((horizontal >> 4) & 15),
      y,
      z: chunkZ * 16 + (horizontal & 15)
    }, blockId)
    observed += 1
  }
  return observed
}

function distanceSquared(a: BlockPosition, b: BlockPosition): number {
  const dx = a.x - b.x
  const dz = a.z - b.z
  return dx * dx + dz * dz
}

function teamForBed(
  bed: BlockPosition,
  markers: RelevantBlock[],
  allowedTeams?: ReadonlySet<BedWarsTeamColor>
): BedWarsTeamColor | null {
  const scores = new Map<BedWarsTeamColor, number>()
  const markerYByTeam = new Map<BedWarsTeamColor, number[]>()
  for (const marker of markers) {
    if (Math.abs(marker.y - bed.y) > 10) continue
    const distance = distanceSquared(marker, bed)
    if (distance > 16 * 16) continue
    const team = TEAM_BY_COLOR_METADATA[marker.metadata]
    if (!team || (allowedTeams && !allowedTeams.has(team))) continue
    scores.set(team, (scores.get(team) || 0) + Math.max(1, 17 - Math.sqrt(distance)))
    const markerYs = markerYByTeam.get(team) || []
    markerYs.push(marker.y)
    markerYByTeam.set(team, markerYs)
  }

  const elevated = Array.from(markerYByTeam.entries())
    .map(([team, markerYs]) => {
      const highestY = Math.max(...markerYs)
      return { team, highestY, upperBlocks: markerYs.filter(y => y >= highestY - 2).length }
    })
    .filter(evidence => evidence.highestY >= bed.y + 4 && evidence.upperBlocks >= 3)
    .sort((left, right) => right.highestY - left.highestY || right.upperBlocks - left.upperBlocks)
  if (elevated[0] && (!elevated[1] || elevated[0].highestY >= elevated[1].highestY + 3)) {
    return elevated[0].team
  }

  const ranked = Array.from(scores.entries()).sort((a, b) => b[1] - a[1])
  if (!ranked.length || ranked[0][1] < 12) return null
  if (ranked[1] && ranked[1][1] >= ranked[0][1] * 0.25) return null
  return ranked[0][0]
}

export function bedDefenseDetections(
  state: BedDefenseState,
  allowedTeams?: ReadonlySet<BedWarsTeamColor>
): BedDefenseDetection[] {
  const blocks = Array.from(state.blocks.values())
  const beds = blocks.filter(block => block.id === BED_BLOCK_ID)
  const obsidian = blocks.filter(block => block.id === OBSIDIAN_BLOCK_ID)
  const markers = blocks.filter(block => (
    TEAM_MARKER_BLOCK_IDS.has(block.id) && !state.changedBlockKeys.has(positionKey(block))
  ))
  const byTeam = new Map<BedWarsTeamColor, BedDefenseDetection>()

  for (const bed of beds) {
    const key = positionKey(bed)
    if (state.teamByBedKey.has(key)) continue
    const team = teamForBed(bed, markers, allowedTeams)
    if (team) state.teamByBedKey.set(key, team)
  }

  for (const bed of beds) {
    const nearby = obsidian.filter(block => (
      Math.abs(block.x - bed.x) <= 4
      && Math.abs(block.y - bed.y) <= 3
      && Math.abs(block.z - bed.z) <= 4
    ))
    if (!nearby.length) continue
    const team = state.teamByBedKey.get(positionKey(bed)) || null
    if (!team || (allowedTeams && !allowedTeams.has(team))) continue
    const previous = byTeam.get(team)
    if (!previous || nearby.length > previous.obsidianBlocks) {
      byTeam.set(team, {
        team,
        bed: { x: bed.x, y: bed.y, z: bed.z },
        obsidianBlocks: nearby.length
      })
    }
  }

  return Array.from(byTeam.values()).sort((a, b) => a.team.localeCompare(b.team))
}
