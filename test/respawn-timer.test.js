const assert = require('assert')
const mc = require('minecraft-protocol')
const { __test } = require('../dist/index')
const { DEFAULT_SPLIT_REMINDER } = require('../dist/appConfig')
const {
  BEDWARS_RECONNECT_RESPAWN_MS,
  clearRespawnTimers,
  collectRespawnTimerUpdates,
  createRespawnTimerState,
  respawnTimerSeconds,
  startRespawnTimer
} = require('../dist/state/respawnTimerState')

const timers = createRespawnTimerState()
startRespawnTimer(timers, 'Red_Fighter', 1000)

assert.equal(respawnTimerSeconds(timers, 'red_fighter', 1000), 5)
assert.deepEqual(collectRespawnTimerUpdates(timers, 1000), [{
  playerName: 'Red_Fighter',
  remainingSeconds: 5
}])
assert.deepEqual(collectRespawnTimerUpdates(timers, 1999), [])
assert.deepEqual(collectRespawnTimerUpdates(timers, 2001), [{
  playerName: 'Red_Fighter',
  remainingSeconds: 4
}])
assert.deepEqual(collectRespawnTimerUpdates(timers, 5999), [{
  playerName: 'Red_Fighter',
  remainingSeconds: 1
}])
assert.deepEqual(collectRespawnTimerUpdates(timers, 6000), [{
  playerName: 'Red_Fighter',
  remainingSeconds: null
}])
assert.equal(timers.timersByPlayerKey.size, 0)

startRespawnTimer(timers, 'Red_Fighter', 7000, BEDWARS_RECONNECT_RESPAWN_MS)
assert.equal(respawnTimerSeconds(timers, 'Red_Fighter', 7000), 10)
clearRespawnTimers(timers)

startRespawnTimer(timers, 'Red_Fighter', 7000)
assert.deepEqual(clearRespawnTimers(timers), ['Red_Fighter'])
assert.equal(timers.timersByPlayerKey.size, 0)

const teamRetentionTimers = createRespawnTimerState()
startRespawnTimer(teamRetentionTimers, 'TinyApple', 1000)
assert.deepEqual(
  __test.withRespawningPlayersKeptInTeam({
    team: 'Yellow8',
    mode: 4,
    players: ['TinyApple', 'OtherPlayer']
  }, teamRetentionTimers),
  {
    team: 'Yellow8',
    mode: 4,
    players: ['OtherPlayer']
  }
)
assert.deepEqual(
  __test.withRespawningPlayersKeptInTeam({
    team: 'Yellow8',
    mode: 3,
    players: ['TinyApple']
  }, teamRetentionTimers),
  {
    team: 'Yellow8',
    mode: 3,
    players: ['TinyApple']
  }
)

const session = __test.createSessionState()
const playerInfo = {
  action: 'add_player',
  data: [{
    uuid: '00112233-4455-6677-8899-aabbccddeeff',
    name: 'Red_Fighter',
    properties: [],
    gamemode: 0,
    ping: 42,
    displayName: JSON.stringify({ text: '[VIP] Red_Fighter', color: 'green' })
  }]
}
__test.trackPlayerInfo(playerInfo, session)
__test.trackScoreboardTeam('scoreboard_team', {
  team: 'Green8',
  mode: 0,
  prefix: '§aG §f',
  suffix: '',
  players: ['Red_Fighter']
}, session, new Map())

const activeTimers = createRespawnTimerState()
startRespawnTimer(activeTimers, 'Red_Fighter', 1000)
const respawnPlayerSnapshot = __test.respawnTimerPlayerSnapshot(playerInfo.data[0], session)
session.teams.clear()
__test.trackScoreboardTeam('scoreboard_team', {
  team: 'helper-team',
  mode: 0,
  prefix: '',
  suffix: '',
  players: ['Red_Fighter']
}, session, new Map())
const timerDisplayName = __test.respawnTimerDisplayName(
  respawnPlayerSnapshot,
  new Map(),
  session,
  respawnTimerSeconds(activeTimers, 'Red_Fighter', 1000)
)
const display = JSON.parse(timerDisplayName)
assert.match(JSON.stringify(display), /Red_Fighter/)
assert.match(JSON.stringify(display), /5s/)
assert.equal(display.extra[0].text, '5s ')
assert.equal(display.extra[0].color, 'gold')
assert.equal(display.extra[0].bold, true)
assert.match(JSON.stringify(display.extra[1]), /G /)
assert.match(JSON.stringify(display.extra[1]), /Red_Fighter/)
assert.equal(display.extra[1].color, 'gray')
assert.doesNotMatch(JSON.stringify(display.extra[1]), /green/)
assert.equal(respawnPlayerSnapshot.respawnTeamSnapshot.prefix, '§aG §a')

const nicknameTimers = createRespawnTimerState()
startRespawnTimer(nicknameTimers, 'Red_Fighter', 1000)
const nicknamedTimerDisplayName = __test.respawnTimerDisplayName(
  playerInfo.data[0],
  new Map([['red_fighter', 'Bollen']]),
  session,
  respawnTimerSeconds(nicknameTimers, 'Red_Fighter', 1000)
)
assert.match(nicknamedTimerDisplayName, /Bollen/)
assert.doesNotMatch(nicknamedTimerDisplayName, /Red_Fighter/)
assert.match(nicknamedTimerDisplayName, /5s /)
assert.equal(JSON.parse(nicknamedTimerDisplayName).extra[1].color, 'gray')

const localUuid = '11112222-3333-4444-5555-666677778888'
const matchSession = __test.createSessionState('storabollar', localUuid)
__test.trackPlayerInfo({
  action: 'add_player',
  data: [
    { uuid: localUuid, name: 'storabollar', displayName: JSON.stringify({ text: '[MVP++] storabollar [S1]' }) },
    { uuid: localUuid, name: 'Red_Fighter', displayName: null },
    { uuid: '99992222-3333-4444-5555-666677778888', name: 'GreenMate', displayName: null }
  ]
}, matchSession)
const splitState = __test.createSplitReminderState()
splitState.bedWarsGameActive = true
splitState.stableTeamColorName = 'green'
splitState.stableTeamPlayersByKey.set('storabollar', 'storabollar')
splitState.stableTeamPlayersByKey.set('red_fighter', 'Red_Fighter')
splitState.stableTeamPlayersByKey.set('greenmate', 'GreenMate')
assert.equal(
  __test.localRespawnPlayerName(matchSession, 'storabollar', splitState),
  'Red_Fighter',
  'the nicked Bed Wars roster identity must win over the real account name'
)
__test.trackScoreboardTeam('scoreboard_team', {
  team: 'Red8',
  mode: 0,
  prefix: '§cR §f',
  suffix: '',
  players: ['EnemyPlayer']
}, matchSession, new Map())
__test.trackPlayerInfo({
  action: 'add_player',
  data: [{
    uuid: '77772222-3333-4444-5555-666677778888',
    name: 'EnemyPlayer',
    displayName: null
  }]
}, matchSession)

assert.equal(
  __test.respawnDeathPlayerName(
    'GreenMate fell into the void.',
    DEFAULT_SPLIT_REMINDER,
    matchSession,
    'storabollar',
    splitState,
    1000
  ),
  'GreenMate'
)
assert.equal(
  __test.respawnDeathPlayerName(
    'You fell into the void.',
    DEFAULT_SPLIT_REMINDER,
    matchSession,
    'storabollar',
    splitState,
    1000
  ),
  'Red_Fighter'
)
assert.equal(
  __test.respawnDeathPlayerName(
    'You will respawn in 5 seconds!',
    DEFAULT_SPLIT_REMINDER,
    matchSession,
    'storabollar',
    splitState,
    1000
  ),
  null,
  'countdown chat must not restart the five-second death timer'
)
assert.equal(__test.localRespawnCountdownSeconds('You will respawn in 5 seconds!'), 5)
assert.equal(__test.localRespawnCountdownSeconds('§eYou will respawn in 10 seconds!'), 10)
assert.equal(__test.localRespawnCountdownSeconds('You have respawned!'), null)
assert.equal(__test.packetHasLocalDeathTitleText({
  action: 0,
  text: JSON.stringify({ text: 'YOU DIED!', color: 'red' })
}), true)
assert.equal(__test.packetHasLocalDeathTitleText({
  action: 1,
  text: JSON.stringify({ text: 'You will respawn in 4 seconds!' })
}), false)
assert.equal(
  __test.respawnDeathPlayerName(
    'GreenMate fell into the void. FINAL KILL!',
    DEFAULT_SPLIT_REMINDER,
    matchSession,
    'storabollar',
    splitState,
    1000
  ),
  null
)
assert.equal(
  __test.respawnDeathPlayerName(
    'LateRosterPlayer was killed by EnemyPlayer.',
    DEFAULT_SPLIT_REMINDER,
    matchSession,
    'storabollar',
    splitState,
    1000
  ),
  'LateRosterPlayer'
)
assert.equal(
  __test.respawnDeathPlayerName(
    'EnemyPlayer: I was killed by GreenMate.',
    DEFAULT_SPLIT_REMINDER,
    matchSession,
    'storabollar',
    splitState,
    1000
  ),
  null
)
assert.equal(
  __test.respawnDeathPlayerName(
    'EnemyPlayer was killed by GreenMate.',
    DEFAULT_SPLIT_REMINDER,
    matchSession,
    'storabollar',
    splitState,
    1000
  ),
  'EnemyPlayer'
)
__test.trackScoreboardTeam('scoreboard_team', {
  team: 'Red8',
  mode: 4,
  players: ['EnemyPlayer']
}, matchSession, new Map())
assert.equal(matchSession.teams.get('Red8').players.has('EnemyPlayer'), false)
assert.equal(matchSession.knownTeamByPlayerKey.has('enemyplayer'), true)
assert.equal(
  __test.respawnDeathPlayerName(
    'EnemyPlayer was glazed in BBQ sauce by GreenMate.',
    DEFAULT_SPLIT_REMINDER,
    matchSession,
    'storabollar',
    splitState,
    1000
  ),
  'EnemyPlayer'
)
assert.equal(
  __test.respawnDeathPlayerName(
    'EnemyPlayer got smacked by GreenMate.',
    DEFAULT_SPLIT_REMINDER,
    matchSession,
    'storabollar',
    splitState,
    1000
  ),
  'EnemyPlayer'
)
assert.equal(
  __test.respawnDeathPlayerName(
    'EnemyPlayer disconnected.',
    DEFAULT_SPLIT_REMINDER,
    matchSession,
    'storabollar',
    splitState,
    1000
  ),
  null
)

assert.equal(__test.reconnectedPlayerName('§aGreenMate reconnected.'), 'GreenMate')
assert.equal(__test.reconnectedPlayerName('GreenMate disconnected.'), null)
assert.equal(
  __test.offlinePlayerUuid('Notch'),
  'b50ad385-829d-3141-a216-7e7d7539ba7f'
)

__test.trackPlayerInfo({
  action: 'remove_player',
  data: [{ uuid: '99992222-3333-4444-5555-666677778888' }]
}, matchSession)
assert.equal(matchSession.playersByName.has('greenmate'), false)
assert.equal(matchSession.knownPlayersByName.has('greenmate'), true)
assert.equal(
  __test.disconnectedWhileRespawningPlayerName('GreenMate', matchSession),
  'GreenMate'
)

__test.trackPlayerInfo({
  action: 'add_player',
  data: [{
    uuid: '99992222-3333-4444-5555-666677778888',
    name: 'GreenMate',
    displayName: null
  }]
}, matchSession)
assert.equal(
  __test.disconnectedWhileRespawningPlayerName('GreenMate', matchSession),
  null
)

const coloredDeathComponent = {
  text: '',
  extra: [
    { text: 'Mikazuki', color: 'red' },
    { text: ' was knocked into the void by ' },
    { text: 'Deevk', color: 'green' },
    { text: '.' }
  ]
}
assert.equal(
  __test.bedWarsTeamColorFromChatComponent(coloredDeathComponent, 'Mikazuki'),
  'Red'
)
assert.equal(
  __test.bedWarsTeamColorFromChatComponent({
    text: 'Mikazuki got rekt by VinVisJonge.',
    color: 'gray',
    extra: [{ text: 'Mikazuki', color: 'yellow' }]
  }, 'Mikazuki'),
  'Yellow'
)
assert.equal(
  __test.bedWarsTeamColorFromChatComponent('§eYellowPlayer fell into the void.', 'YellowPlayer'),
  'Yellow'
)

const missingTeamSession = __test.createSessionState()
const missingTeamPlayer = {
  uuid: '12342222-3333-4444-5555-666677778888',
  name: 'Mikazuki',
  displayName: null
}
const missingTeamSnapshot = __test.respawnTimerPlayerSnapshot(
  missingTeamPlayer,
  missingTeamSession,
  'Red'
)
const missingTeamDisplay = __test.respawnTimerDisplayName(
  missingTeamSnapshot,
  new Map(),
  missingTeamSession,
  4
)
assert.match(missingTeamDisplay, /R /)
assert.match(missingTeamDisplay, /Mikazuki/)
assert.equal(JSON.parse(missingTeamDisplay).extra[1].color, 'gray')

const competingTeamsSession = __test.createSessionState()
__test.trackScoreboardTeam('scoreboard_team', {
  team: 'Yellow8',
  mode: 0,
  prefix: '§eY §e',
  suffix: '',
  players: ['Mikazuki']
}, competingTeamsSession, new Map())
__test.trackScoreboardTeam('scoreboard_team', {
  team: 'helper-team',
  mode: 0,
  prefix: '[HELPER] ',
  suffix: '',
  players: ['Mikazuki']
}, competingTeamsSession, new Map())
__test.trackScoreboardTeam('scoreboard_team', {
  team: 'Yellow8',
  mode: 1
}, competingTeamsSession, new Map())
const competingTeamSnapshot = __test.respawnTimerPlayerSnapshot(
  missingTeamPlayer,
  competingTeamsSession,
  'Yellow'
)
assert.equal(competingTeamSnapshot.respawnTeamSnapshot.team, 'Yellow8')
assert.match(competingTeamSnapshot.respawnTeamSnapshot.prefix, /Y /)

assert.equal(__test.isActiveBedWarsMatchScoreboardText('§fDiamond II in §a4:31'), true)
assert.equal(__test.isActiveBedWarsMatchScoreboardText('Emerald III in 0:45'), true)
assert.equal(__test.isActiveBedWarsMatchScoreboardText('BED WARS'), false)

const scoreboardTransitionSession = __test.createSessionState()
__test.trackScoreboardDisplayObjective({
  position: 1,
  name: 'old-bedwars'
}, scoreboardTransitionSession)
__test.trackScoreboardScore({
  itemName: 'Old player row',
  action: 0,
  scoreName: 'old-bedwars',
  value: 5
}, scoreboardTransitionSession)
assert.equal(
  __test.scoreboardSidebarObjectiveWillChange({
    position: 1,
    name: 'new-bedwars'
  }, scoreboardTransitionSession),
  true
)
assert.equal(
  __test.scoreboardSidebarObjectiveWillChange({
    position: 1,
    name: 'old-bedwars'
  }, scoreboardTransitionSession),
  false
)
assert.equal(
  __test.removesDisplayedScoreboardObjective({
    name: 'old-bedwars',
    action: 1
  }, scoreboardTransitionSession),
  true
)
__test.trackScoreboardDisplayObjective({
  position: 1,
  name: 'new-bedwars'
}, scoreboardTransitionSession)
assert.equal(scoreboardTransitionSession.scores.size, 0)

const rejoinedMatchSession = __test.createSessionState()
const rejoinedMatchSplitState = __test.createSplitReminderState()
__test.trackPlayerInfo({
  action: 'add_player',
  data: [{
    uuid: '88882222-3333-4444-5555-666677778888',
    name: 'RejoinedMate',
    displayName: null
  }]
}, rejoinedMatchSession)
__test.trackScoreboardScore({
  itemName: '§fDiamond II in §a4:31',
  action: 0,
  scoreName: 'bedwars',
  value: 7
}, rejoinedMatchSession)
assert.equal(
  __test.restoreBedWarsGameStateFromScoreboard(rejoinedMatchSession, rejoinedMatchSplitState, 12345),
  true
)
assert.equal(rejoinedMatchSplitState.bedWarsGameActive, true)
assert.equal(rejoinedMatchSplitState.bedWarsGameStartedAt, 12345)
assert.equal(
  __test.respawnDeathPlayerName(
    'RejoinedMate was killed by EnemyPlayer.',
    DEFAULT_SPLIT_REMINDER,
    rejoinedMatchSession,
    'storabollar',
    rejoinedMatchSplitState,
    12345
  ),
  'RejoinedMate'
)
assert.equal(
  __test.restoreBedWarsGameStateFromScoreboard(rejoinedMatchSession, rejoinedMatchSplitState, 12346),
  false
)

const replaySession = __test.createSessionState('storabollar', localUuid)
const replaySplitState = __test.createSplitReminderState()
replaySplitState.bedWarsGameActive = true
__test.trackLocalGameMode({ gamemode: 3 }, replaySession)
assert.equal(__test.isLiveBedWarsMatch(replaySession, replaySplitState), false)
assert.equal(
  __test.respawnDeathPlayerName(
    'TinyApple fell into the void.',
    DEFAULT_SPLIT_REMINDER,
    replaySession,
    'storabollar',
    replaySplitState,
    12345
  ),
  null,
  'replay deaths must not create respawn timers'
)

__test.trackPlayerInfo({
  action: 'update_game_mode',
  data: [{ uuid: localUuid, gamemode: 0 }]
}, replaySession)
assert.equal(replaySession.localGameMode, 3, 'unknown local profiles must not change spectator detection')
__test.trackPlayerInfo({
  action: 'add_player',
  data: [{
    uuid: localUuid,
    name: 'storabollar',
    gamemode: 3,
    displayName: null
  }]
}, replaySession)
__test.trackPlayerInfo({
  action: 'update_game_mode',
  data: [{ uuid: localUuid, gamemode: 0 }]
}, replaySession)
assert.equal(replaySession.localGameMode, 0, 'local player-info game-mode updates must be tracked')
__test.trackLocalGameMode({ gamemode: 3 }, replaySession)

const replayScoreboardSession = __test.createSessionState('storabollar', localUuid)
const replayScoreboardSplitState = __test.createSplitReminderState()
__test.trackLocalGameMode({ gameMode: 3 }, replayScoreboardSession)
__test.trackScoreboardScore({
  itemName: 'Â§fDiamond II in Â§a4:31',
  action: 0,
  scoreName: 'bedwars-replay',
  value: 7
}, replayScoreboardSession)
assert.equal(
  __test.restoreBedWarsGameStateFromScoreboard(
    replayScoreboardSession,
    replayScoreboardSplitState,
    12345
  ),
  false,
  'a Bed Wars replay scoreboard must not restore live-match state'
)
assert.equal(replayScoreboardSplitState.bedWarsGameActive, false)

__test.trackLocalGameMode({ gamemode: 0 }, replaySession)
assert.equal(
  __test.isLiveBedWarsMatch(replaySession, replaySplitState),
  true,
  'survival-mode Bed Wars sessions remain eligible for respawn timers'
)

const protocolPackets = [
  __test.respawnTabRemovePacket('99992222-3333-4444-5555-666677778888'),
  __test.respawnTabAddPacket(
    'GreenMate',
    JSON.stringify({ text: 'GreenMate (10s)' }),
    [{
      name: 'textures',
      value: 'signed-skin-texture-data',
      signature: 'skin-signature'
    }]
  ),
  __test.respawnTabDisplayPacket('GreenMate', JSON.stringify({ text: 'GreenMate (9s)' }))
]
const serializer = mc.createSerializer({
  state: mc.states.PLAY,
  isServer: true,
  version: '1.8.8'
})
const deserializer = mc.createDeserializer({
  state: mc.states.PLAY,
  isServer: false,
  version: '1.8.8'
})
const decodedPackets = []
deserializer.on('data', packet => decodedPackets.push(packet.data))
for (const params of protocolPackets) {
  deserializer.write(serializer.createPacketBuffer({ name: 'player_info', params }))
}

assert.equal(decodedPackets.length, 3)
assert.equal(decodedPackets[0].params.action, 'remove_player')
assert.equal(decodedPackets[1].params.action, 'add_player')
assert.equal(decodedPackets[1].params.data[0].name, 'GreenMate')
assert.equal(decodedPackets[1].params.data[0].gamemode, 0)
assert.deepEqual(decodedPackets[1].params.data[0].properties, [{
  name: 'textures',
  value: 'signed-skin-texture-data',
  signature: 'skin-signature'
}])
assert.match(decodedPackets[1].params.data[0].displayName, /10s/)
assert.equal(decodedPackets[2].params.action, 'update_display_name')
assert.match(decodedPackets[2].params.data[0].displayName, /9s/)
