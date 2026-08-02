const assert = require('node:assert/strict')
const {
  __test,
  createBlockNickHistoryState,
  observeBlockListChat,
  parseBlockListCommand,
  serializeBlockNickHistory,
  trackBlockListCommand
} = require('../dist/state/blockNickHistory')
const { __test: proxyTest } = require('../dist/index')

const header = {
  text: '',
  extra: [
    { text: '-------- ' },
    { text: 'Blocked Players (Page 1 of 1)', color: 'yellow' },
    { text: ' --------' }
  ]
}
const row = name => ({
  text: '',
  extra: [
    { text: '1. ', color: 'aqua' },
    {
      text: name,
      color: 'green',
      hoverEvent: { action: 'show_text', value: { text: 'Click to manage', color: 'gray' } }
    }
  ]
})

const state = createBlockNickHistoryState()
assert.equal(trackBlockListCommand(state, '/block list'), false)
assert.equal(state.trackedBlockedNames.has('list'), false)
assert.equal(parseBlockListCommand('/block removeall').action, 'clear')
assert.equal(state.trackedBlockedNames.has('removeall'), false)
const context = {
  blockedAt: '2026-08-02T12:34:56.000Z',
  teammates: ['TeamMate1', 'TeamMate2'],
  yourTeammates: ['OwnMate'],
  team: 'Green',
  mode: 'Doubles',
  map: 'Dreamgrove'
}
assert.equal(trackBlockListCommand(state, '/block add renantop10', context), true)
assert.equal(state.trackedBlockedNames.get('renantop10'), 'renantop10')
assert.deepEqual(state.contextsByBlockedName.get('renantop10'), context)

observeBlockListChat(state, header, 1_000)
const nickObservation = observeBlockListChat(state, row('renantop10'), 1_001)
assert.equal(nickObservation.learned, null)
assert.equal(nickObservation.changed, true)
assert.deepEqual(state.snapshotsByPage.get(1), { 1: 'renantop10' })
assert.match(JSON.stringify(nickObservation.component), /Blocked nickname:/)
assert.match(JSON.stringify(nickObservation.component), /TeamMate1, TeamMate2/)

observeBlockListChat(state, header, 2_000)
const realNameObservation = observeBlockListChat(state, row('RealAccount'), 2_001)
assert.deepEqual(realNameObservation.learned, {
  currentName: 'RealAccount',
  previousNames: ['renantop10']
})
assert.match(JSON.stringify(realNameObservation.component), /Blocked nickname:/)
assert.match(JSON.stringify(realNameObservation.component), /renantop10/)
assert.match(JSON.stringify(realNameObservation.component), /Click to manage/)
assert.match(JSON.stringify(realNameObservation.component), /TeamMate1, TeamMate2/)
assert.match(JSON.stringify(realNameObservation.component), /Your teammates:/)
assert.match(JSON.stringify(realNameObservation.component), /OwnMate/)
assert.match(JSON.stringify(realNameObservation.component), /Green/)
assert.match(JSON.stringify(realNameObservation.component), /Doubles/)
assert.match(JSON.stringify(realNameObservation.component), /Dreamgrove/)
assert.match(JSON.stringify(realNameObservation.component), /Blocked:/)

const restored = createBlockNickHistoryState(serializeBlockNickHistory(state))
observeBlockListChat(restored, header, 3_000)
const restoredObservation = observeBlockListChat(restored, row('RealAccount'), 3_001)
assert.match(JSON.stringify(restoredObservation.component), /renantop10/)
assert.match(JSON.stringify(restoredObservation.component), /TeamMate1, TeamMate2/)

const oldFile = {
  version: 1,
  trackedBlockedNames: { oldnick: 'OldNick' },
  aliasesByCurrentName: {},
  snapshotsByPage: {}
}
const migrated = createBlockNickHistoryState(oldFile)
assert.equal(migrated.trackedBlockedNames.get('oldnick'), 'OldNick')
assert.equal(migrated.contextsByBlockedName.size, 0)

assert.equal(trackBlockListCommand(restored, '/unblock AnotherPlayer'), true)
assert.equal(restored.snapshotsByPage.size, 0, 'structural changes must invalidate positional snapshots')
observeBlockListChat(restored, header, 4_000)
const changedAfterMutation = observeBlockListChat(restored, row('UnrelatedPlayer'), 4_001)
assert.equal(changedAfterMutation.learned, null, 'a shifted row must not be linked after a block-list mutation')

assert.deepEqual(__test.blockListHeader('Blocked Players (Page 2 of 3)'), { page: 2, totalPages: 3 })
assert.deepEqual(__test.blockListRow('§b12. §aSome_Player'), { row: 12, name: 'Some_Player' })

assert.deepEqual(parseBlockListCommand('/block SomeNick'), { action: 'add', name: 'SomeNick' })
assert.deepEqual(parseBlockListCommand('/ignore remove SomeNick'), { action: 'remove', name: 'SomeNick' })

const matchSession = proxyTest.createSessionState()
proxyTest.trackPlayerInfo({
  action: 'add_player',
  data: [
    { uuid: '00000000-0000-0000-0000-000000000001', name: 'BlockedNick', displayName: JSON.stringify({ text: 'G BlockedNick' }) },
    { uuid: '00000000-0000-0000-0000-000000000002', name: 'TheirMate', displayName: JSON.stringify({ text: 'G TheirMate' }) },
    { uuid: '00000000-0000-0000-0000-000000000003', name: 'Enemy', displayName: JSON.stringify({ text: 'R Enemy' }) }
  ]
}, matchSession)
assert.deepEqual(proxyTest.blockedPlayerTeamContext(matchSession, 'BlockedNick'), {
  team: 'Green',
  teammates: ['TheirMate']
})
const tabModeSession = proxyTest.createSessionState()
proxyTest.trackPlayerInfo({
  action: 'add_player',
  data: ['R', 'G', 'B', 'Y'].flatMap((letter, teamIndex) => Array.from({ length: 4 }, (_, playerIndex) => ({
    uuid: `20000000-0000-0000-0000-${String(teamIndex * 4 + playerIndex).padStart(12, '0')}`,
    name: `${letter}Player${playerIndex}`,
    displayName: JSON.stringify({ text: `${letter} ${letter}Player${playerIndex}` })
  })))
}, tabModeSession)
assert.equal(proxyTest.currentBedWarsModeName(tabModeSession, proxyTest.createSplitReminderState()), '4v4v4v4')
const splitTeamSession = proxyTest.createSessionState()
proxyTest.trackPlayerInfo({
  action: 'add_player',
  data: [{ uuid: '10000000-0000-0000-0000-000000000001', name: 'SplitNick', displayName: JSON.stringify({ text: 'A SplitNick' }) }]
}, splitTeamSession)
proxyTest.trackScoreboardTeam('scoreboard_team', {
  team: 'aqua-target', mode: 0, prefix: '§bA ', suffix: '', players: ['SplitNick']
}, splitTeamSession, new Map())
proxyTest.trackScoreboardTeam('scoreboard_team', {
  team: 'aqua-mates', mode: 0, prefix: '§bA ', suffix: '', players: ['MateOne', 'MateTwo']
}, splitTeamSession, new Map())
assert.deepEqual(proxyTest.blockedPlayerTeamContext(splitTeamSession, 'SplitNick'), {
  team: 'Aqua',
  teammates: ['MateOne', 'MateTwo']
})
const noDisplaySession = proxyTest.createSessionState()
proxyTest.trackPlayerInfo({
  action: 'add_player',
  data: [
    { uuid: '40000000-0000-0000-0000-000000000001', name: 'NoDisplayNick', displayName: null },
    { uuid: '40000000-0000-0000-0000-000000000002', name: 'NoDisplayMate', displayName: null }
  ]
}, noDisplaySession)
proxyTest.trackScoreboardTeam('scoreboard_team', {
  team: 'Pink14', mode: 0, prefix: '§dP ', suffix: '', players: ['NoDisplayMate']
}, noDisplaySession, new Map())
proxyTest.trackScoreboardTeam('scoreboard_team', {
  team: 'Pink15', mode: 0, prefix: '§dP ', suffix: '', players: ['NoDisplayNick']
}, noDisplaySession, new Map())
assert.deepEqual(proxyTest.blockedPlayerTeamContext(noDisplaySession, 'NoDisplayNick', 2), {
  team: 'Pink',
  teammates: ['NoDisplayMate']
})
const ownTeamSession = proxyTest.createSessionState('LocalMe')
proxyTest.trackScoreboardTeam('scoreboard_team', {
  team: 'Green10', mode: 0, prefix: '§aG ', suffix: '', players: ['LocalMe']
}, ownTeamSession, new Map())
proxyTest.trackScoreboardTeam('scoreboard_team', {
  team: 'Green11', mode: 0, prefix: '§aG ', suffix: '', players: ['OwnMate']
}, ownTeamSession, new Map())
assert.deepEqual(proxyTest.localTeammatesForBlockContext(ownTeamSession, 'LocalMe', 2), ['OwnMate'])
const colorFallbackSession = proxyTest.createSessionState()
proxyTest.trackPlayerInfo({
  action: 'add_player',
  data: [
    { uuid: '30000000-0000-0000-0000-000000000001', name: 'WhiteNick', displayName: JSON.stringify({ text: 'W WhiteNick' }) },
    { uuid: '30000000-0000-0000-0000-000000000002', name: 'ColorMate', displayName: JSON.stringify({ text: 'ColorMate', color: 'white' }) },
    { uuid: '30000000-0000-0000-0000-000000000003', name: 'ExtraWhite', displayName: JSON.stringify({ text: 'ExtraWhite', color: 'white' }) }
  ]
}, colorFallbackSession)
assert.deepEqual(proxyTest.blockedPlayerTeamContext(colorFallbackSession, 'WhiteNick', 2), {
  team: 'White',
  teammates: ['ColorMate']
})
matchSession.scores.set('map', { itemName: 'Map: Dreamgrove', scoreName: '' })
assert.equal(proxyTest.bedWarsMapNameFromScoreboard(matchSession), 'Dreamgrove')
matchSession.scores.set('map', { itemName: 'Map: Lighthous e', scoreName: '' })
assert.equal(proxyTest.bedWarsMapNameFromScoreboard(matchSession), 'Lighthouse')
const matchSplitState = proxyTest.createSplitReminderState()
matchSplitState.stableTeamMaxPlayersSource = 'mode:Doubles'
assert.equal(proxyTest.currentBedWarsModeName(matchSession, matchSplitState), 'Doubles')

const clearState = createBlockNickHistoryState(serializeBlockNickHistory(state))
assert.equal(trackBlockListCommand(clearState, '/block removeall'), true)
assert.equal(clearState.trackedBlockedNames.size, 0)
assert.equal(clearState.aliasesByCurrentName.size, 0)
assert.equal(clearState.snapshotsByPage.size, 0)
assert.equal(clearState.contextsByBlockedName.size, 0)

const repeatedState = createBlockNickHistoryState()
trackBlockListCommand(repeatedState, '/block RepeatNick', { blockedAt: 'first', teammates: ['FirstMate'], mode: 'Doubles', map: 'Lighthouse' })
trackBlockListCommand(repeatedState, '/block RepeatNick', { blockedAt: 'second', teammates: [], team: 'Pink' })
assert.deepEqual(repeatedState.contextsByBlockedName.get('repeatnick'), {
  blockedAt: 'second', teammates: ['FirstMate'], team: 'Pink', mode: 'Doubles', map: 'Lighthouse'
})

console.log('block nick history tests passed')
