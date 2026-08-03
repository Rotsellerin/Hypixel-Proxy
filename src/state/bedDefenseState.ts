export type BedWarsTeamColor = 'Red' | 'Blue' | 'Green' | 'Yellow' | 'Aqua' | 'White' | 'Pink' | 'Gray'

type BlockPosition = { x: number; y: number; z: number }
type RelevantBlock = BlockPosition & { id: number; metadata: number }

export type BedDefenseDetection = {
  team: BedWarsTeamColor
  bed: BlockPosition
  obsidianBlocks: number
}

export type BedDefenseState = {
  blocks: Map<string, RelevantBlock>
  changedBlockKeys: Set<string>
  teamByBedKey: Map<string, BedWarsTeamColor>
  announcedTeams: Set<BedWarsTeamColor>
}

const BED_BLOCK_ID = 26
const OBSIDIAN_BLOCK_ID = 49
// Every Hypixel Bed Wars base contains permanent wool in its team color.
// Other colored blocks are map decoration and are deliberately ignored.
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
  const previous = state.blocks.get(key)
  const nextId = blockStateId >> 4
  if (TEAM_MARKER_BLOCK_IDS.has(nextId) || (previous && TEAM_MARKER_BLOCK_IDS.has(previous.id))) {
    state.changedBlockKeys.add(key)
  }
  setBlock(state, position, blockStateId)
}

function clearChunkSections(state: BedDefenseState, chunkX: number, chunkZ: number, bitMap: number) {
  for (const [key, block] of state.blocks) {
    if ((block.x >> 4) !== chunkX || (block.z >> 4) !== chunkZ) continue
    if ((bitMap & (1 << (block.y >> 4))) !== 0) state.blocks.delete(key)
  }
}

function scanChunk(
  state: BedDefenseState,
  chunkX: number,
  chunkZ: number,
  bitMap: number,
  data: Buffer,
  offset = 0
): boolean {
  const sections = sectionCount(bitMap)
  const blockBytes = sections * 4096 * 2
  if (!Number.isInteger(chunkX) || !Number.isInteger(chunkZ) || offset < 0 || data.length < offset + blockBytes) {
    return false
  }

  clearChunkSections(state, chunkX, chunkZ, bitMap)
  let sectionDataOffset = offset
  for (let sectionY = 0; sectionY < 16; sectionY += 1) {
    if ((bitMap & (1 << sectionY)) === 0) continue
    for (let index = 0; index < 4096; index += 1) {
      const blockStateId = data.readUInt16LE(sectionDataOffset + index * 2)
      const id = blockStateId >> 4
      if (!relevantBlock(id)) continue
      const x = index & 15
      const z = (index >> 4) & 15
      const y = (index >> 8) & 15
      setBlock(state, {
        x: chunkX * 16 + x,
        y: sectionY * 16 + y,
        z: chunkZ * 16 + z
      }, blockStateId)
    }
    sectionDataOffset += 4096 * 2
  }
  return true
}

export function createBedDefenseState(): BedDefenseState {
  return {
    blocks: new Map(),
    changedBlockKeys: new Set(),
    teamByBedKey: new Map(),
    announcedTeams: new Set()
  }
}

export function resetBedDefenseState(state: BedDefenseState) {
  state.blocks.clear()
  state.changedBlockKeys.clear()
  state.teamByBedKey.clear()
  state.announcedTeams.clear()
}

export function observeBedDefenseChunk(packet: any, state: BedDefenseState): boolean {
  const data = packet?.chunkData
  if (!Buffer.isBuffer(data)) return false
  return scanChunk(state, Number(packet.x), Number(packet.z), Number(packet.bitMap), data)
}

export function observeBedDefenseBulk(packet: any, state: BedDefenseState): number {
  const data = packet?.data
  const chunks = Array.isArray(packet?.meta) ? packet.meta : []
  if (!Buffer.isBuffer(data) || !chunks.length) return 0

  const skyLightSent = packet.skyLightSent === true
  let offset = 0
  let observed = 0
  for (const chunk of chunks) {
    const bitMap = Number(chunk?.bitMap) || 0
    const sections = sectionCount(bitMap)
    const chunkLength = sections * (8192 + 2048 + (skyLightSent ? 2048 : 0)) + 256
    if (offset + chunkLength > data.length) break
    if (scanChunk(state, Number(chunk.x), Number(chunk.z), bitMap, data, offset)) observed += 1
    offset += chunkLength
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
    if (!team) continue
    if (allowedTeams && !allowedTeams.has(team)) continue
    scores.set(team, (scores.get(team) || 0) + Math.max(1, 17 - Math.sqrt(distance)))
    const markerYs = markerYByTeam.get(team) || []
    markerYs.push(marker.y)
    markerYByTeam.set(team, markerYs)
  }

  const elevated = Array.from(markerYByTeam.entries())
    .map(([team, markerYs]) => {
      const highestY = Math.max(...markerYs)
      const upperBlocks = markerYs.filter(y => y >= highestY - 2).length
      return { team, highestY, upperBlocks }
    })
    .filter(evidence => evidence.highestY >= bed.y + 4 && evidence.upperBlocks >= 3)
    .sort((left, right) => right.highestY - left.highestY || right.upperBlocks - left.upperBlocks)
  if (elevated[0] && (!elevated[1] || elevated[0].highestY >= elevated[1].highestY + 3)) {
    return elevated[0].team
  }

  const ranked = Array.from(scores.entries()).sort((a, b) => b[1] - a[1])
  if (!ranked.length) return null
  if (ranked[0][1] < 12) return null
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
    TEAM_MARKER_BLOCK_IDS.has(block.id)
    && !state.changedBlockKeys.has(positionKey(block))
  ))
  const byTeam = new Map<BedWarsTeamColor, BedDefenseDetection>()

  // Base ownership is learned as soon as a bed and its original surroundings
  // are loaded. Player-placed wool later in the match must not rename the bed.
  for (const bed of beds) {
    const key = positionKey(bed)
    const lockedTeam = state.teamByBedKey.get(key)
    if (lockedTeam) continue
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
    if (!team) continue
    if (allowedTeams && !allowedTeams.has(team)) continue
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

export function collectNewBedDefenseDetections(
  state: BedDefenseState,
  allowedTeams?: ReadonlySet<BedWarsTeamColor>
): BedDefenseDetection[] {
  const detections = bedDefenseDetections(state, allowedTeams)
  const fresh = detections.filter(detection => !state.announcedTeams.has(detection.team))
  for (const detection of fresh) state.announcedTeams.add(detection.team)
  return fresh
}
