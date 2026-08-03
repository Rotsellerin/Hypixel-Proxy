export type BedWarsTeamColor = 'Red' | 'Blue' | 'Green' | 'Yellow' | 'Aqua' | 'White' | 'Pink' | 'Gray'
export type ObsidianDetectionSource = 'held' | 'base'

export type ObsidianHolderDetection = {
  team: BedWarsTeamColor
  playerName: string
  source: ObsidianDetectionSource
}

export type ObsidianDetectorState = {
  detectionsByTeam: Map<BedWarsTeamColor, ObsidianHolderDetection>
  announcedTeams: Set<BedWarsTeamColor>
}

const OBSIDIAN_ITEM_ID = 49

export function createObsidianDetectorState(): ObsidianDetectorState {
  return {
    detectionsByTeam: new Map(),
    announcedTeams: new Set()
  }
}

export function resetObsidianDetectorState(state: ObsidianDetectorState) {
  state.detectionsByTeam.clear()
  state.announcedTeams.clear()
}

export function equipmentPacketHoldsObsidian(packet: any): boolean {
  return Number(packet?.slot) === 0 && Number(packet?.item?.blockId) === OBSIDIAN_ITEM_ID
}

export function rememberObsidianHolder(
  state: ObsidianDetectorState,
  detection: ObsidianHolderDetection
): boolean {
  if (!state.detectionsByTeam.has(detection.team)) {
    state.detectionsByTeam.set(detection.team, detection)
  }
  if (state.announcedTeams.has(detection.team)) return false
  state.announcedTeams.add(detection.team)
  return true
}

export function obsidianHolderDetections(state: ObsidianDetectorState): ObsidianHolderDetection[] {
  return Array.from(state.detectionsByTeam.values()).sort((a, b) => a.team.localeCompare(b.team))
}

export const __test = { OBSIDIAN_ITEM_ID }
