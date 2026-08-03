const assert = require('assert')
const { __test } = require('../dist/index')
const {
  createObsidianDetectorState,
  equipmentPacketHoldsObsidian,
  obsidianHolderDetections,
  rememberObsidianHolder,
  resetObsidianDetectorState
} = require('../dist/state/obsidianDetectorState')
const {
  createSessionState,
  trackEntityEquipment,
  trackNamedEntitySpawn,
  trackPlayerInfo,
  trackScoreboardTeam
} = require('../dist/state/sessionState')

assert.equal(equipmentPacketHoldsObsidian({ slot: 0, item: { blockId: 49 } }), true)
assert.equal(equipmentPacketHoldsObsidian({ slot: 1, item: { blockId: 49 } }), false)
assert.equal(equipmentPacketHoldsObsidian({ slot: 0, item: { blockId: 5 } }), false)
assert.equal(equipmentPacketHoldsObsidian({ slot: 0, item: null }), false)

const detector = createObsidianDetectorState()
assert.equal(rememberObsidianHolder(detector, { team: 'Gray', playerName: 'GrayPlayer', source: 'held' }), true)
assert.equal(rememberObsidianHolder(detector, { team: 'Gray', playerName: 'Base detector', source: 'base' }), false)
assert.deepEqual(obsidianHolderDetections(detector), [
  { team: 'Gray', playerName: 'GrayPlayer', source: 'held' }
])
resetObsidianDetectorState(detector)
assert.deepEqual(obsidianHolderDetections(detector), [])
assert.equal(detector.announcedTeams.size, 0)

const session = createSessionState()
trackPlayerInfo({
  action: 0,
  data: [{ uuid: '11111111-2222-3333-4444-555555555555', name: 'GrayPlayer' }]
}, session)
trackNamedEntitySpawn({
  entityId: 42,
  playerUUID: '11111111-2222-3333-4444-555555555555',
  metadata: []
}, session)
trackEntityEquipment({ entityId: 42, slot: 0, item: { blockId: 49, itemCount: 3 } }, session)

// Equipment may arrive before TAB/scoreboard team data. It should become
// detectable as soon as the player's team is known.
assert.deepEqual(__test.obsidianHoldersFromSession(session, new Set(['Gray'])), [])
trackScoreboardTeam('scoreboard_team', {
  team: 'Gray2',
  mode: 0,
  prefix: '§7S §7',
  suffix: '',
  players: ['GrayPlayer']
}, session)
assert.deepEqual(
  __test.obsidianHoldersFromSession(session, new Set(['Gray'])),
  [{ team: 'Gray', playerName: 'GrayPlayer', source: 'held' }]
)
assert.deepEqual(__test.obsidianHoldersFromSession(session, new Set(['Red'])), [])

trackEntityEquipment({ entityId: 42, slot: 0, item: { blockId: -1 } }, session)
assert.deepEqual(__test.obsidianHoldersFromSession(session, new Set(['Gray'])), [])

const scoreboardSession = createSessionState()
scoreboardSession.displayedScoreboardObjectives.set(1, 'bedwars')
for (const [itemName, key] of [
  ['\u00a7cR Red: \u00a7a\u2713 YOU', 'red'],
  ['\u00a7bA Aqua: \u00a7a\u2714', 'aqua'],
  ['\u00a77S Gray: \u00a7c\u2717', 'gray'],
  ['\u00a79B Blue: \u00a7c\u2717', 'blue']
]) {
  scoreboardSession.scores.set(key, { itemName, scoreName: 'bedwars' })
}
assert.deepEqual(
  Array.from(__test.activeBedWarsTeamColors(scoreboardSession)).sort(),
  ['Aqua', 'Red']
)
assert.deepEqual(
  Array.from(__test.activeOpponentBedWarsTeamColors(new Set(['Aqua', 'Red']), 'aqua')).sort(),
  ['Red']
)
assert.deepEqual(
  Array.from(__test.activeOpponentBedWarsTeamColors(new Set(['Aqua', 'Red']), '\u00a7bAqua')).sort(),
  ['Red']
)
assert.deepEqual(
  Array.from(__test.activeOpponentBedWarsTeamColors(new Set(['Aqua', 'Red']), null)),
  []
)
assert.deepEqual(
  Array.from(__test.activeOpponentBedWarsTeamColors(new Set(['Aqua', 'Red']), 'Unknown')),
  []
)
assert.equal(__test.isBedDefenseScoreboardContext(scoreboardSession), false)
scoreboardSession.scores.set('timer', {
  itemName: 'Diamond II in 5:00',
  scoreName: 'bedwars'
})
assert.equal(__test.isBedDefenseScoreboardContext(scoreboardSession), true)

const lobbySession = createSessionState()
lobbySession.displayedScoreboardObjectives.set(1, 'lobby')
lobbySession.scores.set('lobby', { itemName: 'BED WARS LOBBY', scoreName: 'lobby' })
assert.equal(__test.isBedDefenseScoreboardContext(lobbySession), false)

console.log('obsidian detector tests passed')
