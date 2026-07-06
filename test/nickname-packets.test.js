const assert = require('assert')
const { __test } = require('../dist/index')

const nicknames = new Map([['998r', 'Bollen']])

const playerInfo = {
  action: 'add_player',
  data: [{
    uuid: '00112233-4455-6677-8899-aabbccddeeff',
    name: '998r',
    properties: [],
    gamemode: 0,
    ping: 47,
    displayName: JSON.stringify({ text: '[VIP] 998r', color: 'green' })
  }]
}

const rewrittenPlayerInfo = __test.withNicknamePlayerInfo(playerInfo, nicknames)
assert.equal(rewrittenPlayerInfo.data[0].name, 'Bollen')
assert.match(rewrittenPlayerInfo.data[0].displayName, /Bollen/)
assert.doesNotMatch(rewrittenPlayerInfo.data[0].displayName, /998r/)

const teamPacket = {
  team: 'vip-team',
  mode: 0,
  name: 'vip-team',
  prefix: '[VIP] ',
  suffix: ' [S1]',
  friendlyFire: 0,
  nameTagVisibility: 'always',
  color: 10,
  players: ['998r']
}

const rewrittenTeam = __test.withNicknameScoreboardTeam(teamPacket, nicknames)
assert.equal(rewrittenTeam.prefix, '[VIP] ')
assert.equal(rewrittenTeam.suffix, ' [S1]')
assert.deepEqual(rewrittenTeam.players, ['Bollen'])

const scorePacket = {
  itemName: '998r',
  action: 0,
  scoreName: 'health',
  value: 20
}
const rewrittenScore = __test.withNicknameScoreboardScore(scorePacket, nicknames)
assert.equal(rewrittenScore.itemName, 'Bollen')
assert.equal(rewrittenScore.scoreName, 'health')
assert.equal(rewrittenScore.value, 20)

const metadataPacket = {
  entityId: 7,
  metadata: [
    { key: 2, type: 4, value: '[VIP] 998r [S1]' },
    { key: 3, type: 0, value: 1 }
  ]
}
const rewrittenMetadata = __test.withNicknameEntityMetadata(metadataPacket, nicknames)
assert.equal(rewrittenMetadata.metadata[0].value, '[VIP] Bollen [S1]')
assert.equal(rewrittenMetadata.metadata[1].value, 1)

const state = __test.createSessionState()
__test.trackPlayerInfo(playerInfo, state)
__test.trackScoreboardTeam('scoreboard_team', teamPacket, state, new Map())
__test.trackScoreboardScore(scorePacket, state)
__test.trackNamedEntitySpawn({
  entityId: 7,
  playerUUID: playerInfo.data[0].uuid,
  x: 100,
  y: 200,
  z: 300,
  yaw: 0,
  pitch: 0,
  currentItem: 0,
  metadata: []
}, state)

const writes = []
const downstream = {
  write (name, params) {
    writes.push({ name, params })
  }
}

__test.refreshLocalNicknames(downstream, state, nicknames)

assert.ok(writes.some(write => write.name === 'player_info' && write.params.action === 'remove_player'))
assert.ok(writes.some(write => write.name === 'player_info' && write.params.action === 'add_player' && write.params.data[0].name === 'Bollen'))
assert.ok(writes.some(write => write.name === 'scoreboard_team' && write.params.mode === 4 && write.params.players.includes('998r')))
assert.ok(writes.some(write => write.name === 'scoreboard_team' && write.params.mode === 3 && write.params.players.includes('Bollen')))
assert.ok(writes.some(write => write.name === 'scoreboard_score' && write.params.itemName === 'Bollen' && write.params.scoreName === 'health' && write.params.value === 20))
assert.ok(writes.some(write => write.name === 'entity_destroy' && write.params.entityIds.includes(7)))
assert.ok(writes.some(write => write.name === 'named_entity_spawn' && write.params.entityId === 7 && write.params.playerUUID === playerInfo.data[0].uuid))
