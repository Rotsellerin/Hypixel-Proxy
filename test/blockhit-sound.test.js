const assert = require('assert')
const {
  blockHitSoundPacket,
  createBlockHitSoundState,
  observeBlockHitEntityStatus,
  observeBlockHitHealth,
  releaseSwordBlock,
  resetBlockHitSoundState,
  trackBlockHitLocalEntity,
  trackBlockHitPosition,
  trackSwordBlock
} = require('../dist/state/blockHitSoundState')

const state = createBlockHitSoundState()
trackBlockHitLocalEntity({ entityId: 42 }, state)
trackBlockHitPosition({ x: 10.25, y: 64, z: -3.5 }, state)

assert.equal(trackSwordBlock({ direction: -1, heldItem: { blockId: 276 } }, state), true)
assert.equal(observeBlockHitHealth({ health: 20 }, state, 1000), false)
assert.equal(observeBlockHitHealth({ health: 18 }, state, 1100), true)
assert.equal(observeBlockHitEntityStatus({ entityId: 42, entityStatus: 2 }, state, 1150), false)
assert.equal(observeBlockHitEntityStatus({ entityId: 41, entityStatus: 2 }, state, 1500), false)
assert.equal(observeBlockHitEntityStatus({ entityId: 42, entityStatus: 3 }, state, 1500), false)
assert.equal(observeBlockHitEntityStatus({ entityId: 42, entityStatus: 2 }, state, 1500), true)

assert.deepEqual(blockHitSoundPacket(state), {
  soundName: 'mob.irongolem.hit',
  x: 82,
  y: 512,
  z: -28,
  volume: 0.5,
  pitch: 63
})
assert.equal(blockHitSoundPacket(state, 0.22).volume, 0.22)
assert.equal(blockHitSoundPacket(state, 2).volume, 1)
assert.equal(blockHitSoundPacket(state, -1).volume, 0)

releaseSwordBlock(state, 1800)
assert.equal(observeBlockHitHealth({ health: 16 }, state, 2000), true)
assert.equal(observeBlockHitHealth({ health: 14 }, state, 2200), false)
assert.equal(observeBlockHitHealth({ health: 12 }, state, 2201), false)
assert.equal(trackSwordBlock({ direction: 255, heldItem: { blockId: 267 } }, state), true)
releaseSwordBlock(state, 2300)
assert.equal(observeBlockHitHealth({ health: 10 }, state, 2601), false)
assert.equal(trackSwordBlock({ direction: 255, heldItem: { blockId: 1 } }, state), false)
assert.equal(trackSwordBlock({ direction: 1, heldItem: { blockId: 276 } }, state), false)

resetBlockHitSoundState(state)
assert.equal(state.blockingWithSword, false)
assert.equal(state.lastHealth, null)
assert.equal(state.position, null)
assert.equal(blockHitSoundPacket(state), null)

console.log('blockhit sound tests passed')
