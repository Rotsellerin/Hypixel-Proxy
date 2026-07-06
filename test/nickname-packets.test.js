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

assert.equal(__test.lobbyCommandKey('/l'), 'lobby')
assert.equal(__test.lobbyCommandKey('  /L  '), 'lobby')
assert.equal(__test.lobbyCommandKey('/lobby bedwars'), 'lobby:bedwars')
assert.equal(__test.lobbyCommandKey('/bedwars'), 'lobby:bedwars')
assert.equal(__test.lobbyCommandKey('/bw'), 'lobby:bedwars')
assert.equal(__test.lobbyCommandKey('/lobby duels'), 'lobby:duels')
assert.equal(__test.lobbyCommandKey('/duels'), 'lobby:duels')
assert.equal(__test.lobbyCommandKey('/hub'), 'lobby')
assert.equal(__test.lobbyCommandKey('/leave'), 'lobby')
assert.equal(__test.lobbyCommandKey('/msg friend hello'), null)
assert.equal(__test.lobbyCommandKey('/play bedwars_four_four'), null)

assert.equal(__test.cleanWindowTitle('{"text":"§aGame Menu"}'), 'Game Menu')
assert.equal(__test.isLobbySelectorWindowTitle('{"text":"Game Menu"}'), true)
assert.equal(__test.isLobbySelectorWindowTitle('{"text":"Lobby Selector"}'), true)
assert.equal(__test.isLobbySelectorWindowTitle('{"text":"Bed Wars Shop"}'), false)
assert.equal(
  __test.lobbyWindowClickKey({ windowId: 4, slot: 11, mouseButton: 0, action: 22, mode: 0 }),
  __test.lobbyWindowClickKey({ windowId: 4, slot: 11, mouseButton: 0, action: 23, mode: 0 })
)
assert.notEqual(
  __test.lobbyWindowClickKey({ windowId: 4, slot: 11, mouseButton: 0, mode: 0 }),
  __test.lobbyWindowClickKey({ windowId: 4, slot: 12, mouseButton: 0, mode: 0 })
)
assert.equal(__test.shouldRawForwardUpstreamPacket('map_chunk'), true)
assert.equal(__test.shouldRawForwardUpstreamPacket('map_chunk_bulk'), true)
assert.equal(__test.shouldRawForwardUpstreamPacket('chat'), false)
assert.equal(__test.shouldRawForwardUpstreamPacket('title'), false)
