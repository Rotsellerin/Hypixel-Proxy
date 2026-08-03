const assert = require('assert')
const {
  bedDefenseBulkChunks,
  bedDefenseDetections,
  clearBedDefenseObsidian,
  createBedDefenseState,
  observeBedDefenseBlockChange,
  observeBedDefenseBulk,
  observeBedDefenseChunk,
  observeBedDefenseMultiBlockChange,
  resetBedDefenseState
} = require('../dist/state/bedDefenseState')

const blockState = (id, metadata = 0) => (id << 4) | metadata

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

const redBase = [
  { x: 2, y: 5, z: 2, id: 26 },
  { x: 3, y: 5, z: 2, id: 26 },
  ...Array.from({ length: 8 }, (_, index) => ({
    x: 1 + (index % 4), y: 4, z: 5 + Math.floor(index / 4), id: 35, metadata: 14
  }))
]

const state = createBedDefenseState()
assert.equal(observeBedDefenseChunk({
  x: 0, z: 0, bitMap: 1, chunkData: chunkData([...redBase, { x: 2, y: 5, z: 3, id: 49 }])
}, state), true)
assert.deepEqual(bedDefenseDetections(state).map(item => item.team), ['Red'])
clearBedDefenseObsidian(state)
assert.deepEqual(bedDefenseDetections(state), [])
assert.ok(Array.from(state.teamByBedKey.values()).includes('Red'))
observeBedDefenseBlockChange({
  location: { x: 2, y: 5, z: 3 }, type: blockState(49)
}, state)
assert.deepEqual(bedDefenseDetections(state).map(item => item.team), ['Red'])

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

// Deferred scanning must never overwrite a newer block-change packet with
// stale chunk contents from before the obsidian was placed.
const staleChunk = chunkData(redBase)
const deferredState = createBedDefenseState()
observeBedDefenseChunk({ x: 0, z: 0, bitMap: 1, chunkData: staleChunk }, deferredState)
bedDefenseDetections(deferredState)
observeBedDefenseBlockChange({
  location: { x: 2, y: 5, z: 3 }, type: blockState(49)
}, deferredState)
observeBedDefenseChunk({ x: 0, z: 0, bitMap: 1, chunkData: staleChunk }, deferredState)
assert.deepEqual(bedDefenseDetections(deferredState).map(item => item.team), ['Red'])

const first = chunkData([...redBase, { x: 2, y: 5, z: 3, id: 49 }])
const blueBase = [
  { x: 17, y: 5, z: 2, id: 26 },
  { x: 18, y: 5, z: 2, id: 26 },
  { x: 18, y: 5, z: 3, id: 49 },
  ...Array.from({ length: 8 }, (_, index) => ({
    x: 17 + (index % 4), y: 4, z: 5 + Math.floor(index / 4), id: 35, metadata: 11
  }))
]
const second = chunkData(blueBase)
const bulkPacket = {
  skyLightSent: true,
  meta: [{ x: 0, z: 0, bitMap: 1 }, { x: 1, z: 0, bitMap: 1 }],
  data: Buffer.concat([first, second])
}
assert.equal(bedDefenseBulkChunks(bulkPacket).length, 2)
const bulkState = createBedDefenseState()
assert.equal(observeBedDefenseBulk(bulkPacket, bulkState), 2)
assert.deepEqual(bedDefenseDetections(bulkState).map(item => item.team), ['Blue', 'Red'])

const allTeams = new Set(['Red', 'Blue', 'Green', 'Yellow', 'Aqua', 'White', 'Pink', 'Gray'])

// Player-placed foreign wool must not rename a base whose permanent wool was
// learned from its clean chunk data.
const foreignWoolState = createBedDefenseState()
const whiteBase = [
  { x: 2, y: 5, z: 2, id: 26 },
  { x: 3, y: 5, z: 2, id: 26 },
  ...Array.from({ length: 12 }, (_, index) => ({
    x: 1 + (index % 4), y: 4, z: 5 + Math.floor(index / 4), id: 35, metadata: 0
  }))
]
observeBedDefenseChunk({ x: 0, z: 0, bitMap: 1, chunkData: chunkData(whiteBase) }, foreignWoolState)
bedDefenseDetections(foreignWoolState, allTeams)
for (let index = 0; index < 40; index += 1) {
  observeBedDefenseBlockChange({
    location: { x: 1 + (index % 8), y: 5 + Math.floor(index / 16), z: 7 + (index % 5) },
    type: blockState(35, 9)
  }, foreignWoolState)
}
observeBedDefenseBlockChange({
  location: { x: 2, y: 5, z: 3 }, type: blockState(49)
}, foreignWoolState)
assert.deepEqual(bedDefenseDetections(foreignWoolState, allTeams).map(item => item.team), ['White'])

// Equal evidence for two team colors is deliberately treated as uncertain.
const ambiguousState = createBedDefenseState()
observeBedDefenseChunk({
  x: 0,
  z: 0,
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
}, ambiguousState)
assert.deepEqual(bedDefenseDetections(ambiguousState, allTeams), [])

// Elevated permanent team wool can identify a late-loaded base even when an
// attacker has surrounded the bed with much more foreign wool.
const lateLoadedState = createBedDefenseState()
observeBedDefenseChunk({
  x: 0,
  z: 0,
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
}, lateLoadedState)
assert.deepEqual(bedDefenseDetections(lateLoadedState, allTeams).map(item => item.team), ['Blue'])

resetBedDefenseState(state)
assert.equal(state.blocks.size, 0)
assert.equal(state.changedBlockKeys.size, 0)
assert.equal(state.teamByBedKey.size, 0)

console.log('bed defense tests passed')
