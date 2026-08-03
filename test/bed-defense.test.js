const assert = require('assert')
const { __test } = require('../dist/index')
const {
  bedDefenseDetections,
  collectNewBedDefenseDetections,
  createBedDefenseState,
  observeBedDefenseBlockChange,
  observeBedDefenseBulk,
  observeBedDefenseChunk,
  observeBedDefenseMultiBlockChange,
  resetBedDefenseState
} = require('../dist/state/bedDefenseState')

const blockState = (id, metadata = 0) => (id << 4) | metadata

const scoreboardState = __test.createSessionState()
scoreboardState.displayedScoreboardObjectives.set(1, 'bedwars')
for (const [key, itemName] of [
  ['red', '§cR Red: §a✓'],
  ['blue', '§9B Blue: §a✓'],
  ['green', '§aG Green: §a✓'],
  ['yellow', '§eY Yellow: §a✓']
]) {
  scoreboardState.scores.set(key, { itemName, scoreName: 'bedwars' })
}
assert.deepEqual(
  Array.from(__test.activeBedWarsTeamColors(scoreboardState)).sort(),
  ['Blue', 'Green', 'Red', 'Yellow']
)

function chunkData(blocks, bitMap = 1, skyLight = true) {
  const sections = Array.from({ length: 16 }, (_, section) => section)
    .filter(section => (bitMap & (1 << section)) !== 0)
  const data = Buffer.alloc(sections.length * (8192 + 2048 + (skyLight ? 2048 : 0)) + 256)
  for (const block of blocks) {
    const sectionIndex = sections.indexOf(block.y >> 4)
    if (sectionIndex < 0) continue
    const localIndex = (block.x & 15) + 16 * ((block.z & 15) + 16 * (block.y & 15))
    data.writeUInt16LE(blockState(block.id, block.metadata || 0), sectionIndex * 8192 + localIndex * 2)
  }
  return data
}

const state = createBedDefenseState()
const blocks = [
  { x: 2, y: 5, z: 2, id: 26 },
  { x: 3, y: 5, z: 2, id: 26 },
  { x: 2, y: 5, z: 3, id: 49 },
  ...Array.from({ length: 8 }, (_, index) => ({
    x: 1 + (index % 4), y: 4, z: 5 + Math.floor(index / 4), id: 35, metadata: 14
  }))
]

assert.equal(observeBedDefenseChunk({
  x: 0, z: 0, groundUp: true, bitMap: 1, chunkData: chunkData(blocks)
}, state), true)
assert.deepEqual(bedDefenseDetections(state).map(item => item.team), ['Red'])
assert.equal(collectNewBedDefenseDetections(state).length, 1)
assert.equal(collectNewBedDefenseDetections(state).length, 0)

observeBedDefenseBlockChange({
  location: { x: 2, y: 5, z: 3 }, type: blockState(0)
}, state)
assert.deepEqual(bedDefenseDetections(state), [])

observeBedDefenseMultiBlockChange({
  chunkX: 0,
  chunkZ: 0,
  records: [{ horizontalPos: (2 << 4) | 3, y: 5, blockId: blockState(49) }]
}, state)
assert.deepEqual(bedDefenseDetections(state).map(item => item.team), ['Red'])

resetBedDefenseState(state)
assert.equal(state.blocks.size, 0)
assert.equal(state.changedBlockKeys.size, 0)
assert.equal(state.teamByBedKey.size, 0)
assert.equal(state.announcedTeams.size, 0)

const bulkState = createBedDefenseState()
const first = chunkData(blocks)
const second = chunkData([
  { x: 17, y: 5, z: 2, id: 26 },
  { x: 18, y: 5, z: 2, id: 49 },
  ...Array.from({ length: 8 }, (_, index) => ({
    x: 17 + (index % 4), y: 4, z: 5 + Math.floor(index / 4), id: 35, metadata: 11
  }))
])
assert.equal(observeBedDefenseBulk({
  skyLightSent: true,
  meta: [{ x: 0, z: 0, bitMap: 1 }, { x: 1, z: 0, bitMap: 1 }],
  data: Buffer.concat([first, second])
}, bulkState), 2)
assert.deepEqual(bedDefenseDetections(bulkState).map(item => item.team), ['Blue', 'Red'])
assert.deepEqual(
  bedDefenseDetections(bulkState, new Set(['Red', 'Green', 'Yellow'])).map(item => item.team),
  ['Red']
)
assert.ok(Array.from(bulkState.teamByBedKey.values()).includes('Blue'))

const foreignWoolState = createBedDefenseState()
const whiteBase = [
  { x: 2, y: 5, z: 2, id: 26 },
  { x: 3, y: 5, z: 2, id: 26 },
  ...Array.from({ length: 12 }, (_, index) => ({
    x: 1 + (index % 4), y: 4, z: 5 + Math.floor(index / 4), id: 35, metadata: 0
  }))
]
observeBedDefenseChunk({
  x: 0, z: 0, groundUp: true, bitMap: 1, chunkData: chunkData(whiteBase)
}, foreignWoolState)
const allTeams = new Set(['Red', 'Blue', 'Green', 'Yellow', 'Aqua', 'White', 'Pink', 'Gray'])
assert.equal(foreignWoolState.teamByBedKey.size, 0)

for (let index = 0; index < 40; index += 1) {
  observeBedDefenseBlockChange({
    location: { x: 1 + (index % 8), y: 5 + Math.floor(index / 16), z: 7 + (index % 5) },
    type: blockState(35, 9)
  }, foreignWoolState)
}
observeBedDefenseBlockChange({
  location: { x: 2, y: 5, z: 3 }, type: blockState(49)
}, foreignWoolState)
assert.deepEqual(
  bedDefenseDetections(foreignWoolState, allTeams).map(item => item.team),
  ['White']
)
assert.equal(foreignWoolState.changedBlockKeys.size, 40)
assert.equal(foreignWoolState.teamByBedKey.size, 2)
assert.ok(Array.from(foreignWoolState.teamByBedKey.values()).every(team => team === 'White'))

const ambiguousFirstLoadState = createBedDefenseState()
observeBedDefenseChunk({
  x: 0,
  z: 0,
  groundUp: true,
  bitMap: 1,
  chunkData: chunkData([
    { x: 2, y: 5, z: 2, id: 26 },
    { x: 2, y: 5, z: 3, id: 49 },
    ...Array.from({ length: 8 }, (_, index) => ({
      x: 1 + (index % 4), y: 4, z: 5 + Math.floor(index / 4), id: 35, metadata: 0
    })),
    ...Array.from({ length: 8 }, (_, index) => ({
      x: 5 + (index % 4), y: 4, z: 5 + Math.floor(index / 4), id: 35, metadata: 9
    }))
  ])
}, ambiguousFirstLoadState)
assert.deepEqual(bedDefenseDetections(ambiguousFirstLoadState, allTeams), [])
assert.equal(ambiguousFirstLoadState.teamByBedKey.size, 0)

const decorativeColorState = createBedDefenseState()
observeBedDefenseChunk({
  x: 0,
  z: 0,
  groundUp: true,
  bitMap: 1,
  chunkData: chunkData([
    { x: 2, y: 5, z: 2, id: 26 },
    { x: 2, y: 5, z: 3, id: 49 },
    ...Array.from({ length: 8 }, (_, index) => ({
      x: 1 + (index % 4), y: 8, z: 8 + Math.floor(index / 4), id: 35, metadata: 0
    })),
    ...Array.from({ length: 32 }, (_, index) => ({
      x: 4 + (index % 8), y: 6 + Math.floor(index / 16), z: 5 + (index % 4), id: 95, metadata: 9
    }))
  ])
}, decorativeColorState)
assert.deepEqual(
  bedDefenseDetections(decorativeColorState, allTeams).map(item => item.team),
  ['White']
)

const lateLoadedDefenseState = createBedDefenseState()
observeBedDefenseChunk({
  x: 0,
  z: 0,
  groundUp: true,
  bitMap: 1,
  chunkData: chunkData([
    { x: 2, y: 5, z: 2, id: 26 },
    { x: 2, y: 5, z: 3, id: 49 },
    ...Array.from({ length: 10 }, (_, index) => ({
      x: 3 + (index % 5), y: 11 + Math.floor(index / 5), z: 10, id: 35, metadata: 11
    })),
    ...Array.from({ length: 64 }, (_, index) => ({
      x: 1 + (index % 8), y: 5 + Math.floor(index / 24), z: 3 + (index % 6), id: 35, metadata: 14
    }))
  ])
}, lateLoadedDefenseState)
assert.deepEqual(
  bedDefenseDetections(lateLoadedDefenseState, allTeams).map(item => item.team),
  ['Blue']
)

console.log('bed defense tests passed')
