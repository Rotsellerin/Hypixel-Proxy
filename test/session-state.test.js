const assert = require('node:assert/strict')
const {
  clearSessionEntityHistory,
  createSessionState,
  pruneSessionHistory,
  sessionStateSizes,
  trackNamedEntitySpawn,
  trackPlayerInfo,
  trackScoreboardTeam
} = require('../dist/state/sessionState')

const localUuid = '11111111-2222-3333-4444-555555555555'
const activeUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const oldUuid = '99999999-8888-7777-6666-555555555555'
const state = createSessionState('storabollar', localUuid)

trackPlayerInfo({
  action: 'add_player',
  data: [
    { uuid: localUuid, name: 'Red_Fighter', gamemode: 0 },
    { uuid: activeUuid, name: 'CurrentPlayer', gamemode: 0 },
    { uuid: oldUuid, name: 'OldPlayer', gamemode: 0 }
  ]
}, state)
trackPlayerInfo({
  action: 'remove_player',
  data: [{ uuid: oldUuid }]
}, state)

trackScoreboardTeam('scoreboard_team', {
  team: 'red',
  mode: 0,
  prefix: '§cR ',
  suffix: '',
  players: ['Red_Fighter', 'CurrentPlayer', 'OldPlayer']
}, state)
trackNamedEntitySpawn({
  entityId: 42,
  playerUUID: oldUuid,
  x: 1,
  y: 2,
  z: 3
}, state)

const before = sessionStateSizes(state)
assert.equal(before.activePlayers, 2)
assert.equal(before.knownPlayers, 3)
assert.equal(before.playerEntities, 1)
assert.equal(before.knownPlayerTeams, 3)

const result = pruneSessionHistory(state, { clearEntities: true })
assert.deepEqual(result.before, before)
assert.equal(result.after.knownPlayers, 2)
assert.equal(result.after.playerUuidMappings, 2)
assert.equal(result.after.playerEntities, 0)
assert.equal(result.after.entityIds, 0)
assert.equal(result.after.knownPlayerTeams, 2)
assert.equal(state.knownPlayersByName.has('oldplayer'), false)
assert.equal(state.knownPlayersByName.has('currentplayer'), true)
assert.equal(state.knownPlayersByName.has('red_fighter'), true)
assert.equal(state.localPlayerAliasesByKey.has('storabollar'), true)
assert.equal(state.localPlayerAliasesByKey.has('red_fighter'), true)
assert.equal(state.knownTeamByPlayerKey.get('currentplayer')?.team, 'red')

trackNamedEntitySpawn({
  entityId: 43,
  playerUUID: activeUuid,
  x: 1,
  y: 2,
  z: 3
}, state)
trackNamedEntitySpawn({
  entityId: 44,
  playerUUID: activeUuid,
  x: 4,
  y: 5,
  z: 6
}, state)
assert.equal(state.playerEntitiesByUuid.size, 1)
assert.equal(state.playerEntityUuidById.size, 1)
assert.equal(state.playerEntityUuidById.has(43), false)
assert.equal(state.playerEntityUuidById.get(44), activeUuid.replace(/-/g, ''))
clearSessionEntityHistory(state)
assert.equal(state.playerEntitiesByUuid.size, 0)
assert.equal(state.playerEntityUuidById.size, 0)

console.log('session state tests passed')
