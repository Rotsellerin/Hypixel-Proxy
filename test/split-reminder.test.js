const assert = require('assert')
const { DEFAULT_SPLIT_REMINDER } = require('../dist/appConfig')
const { __test } = require('../dist/index')

const settings = DEFAULT_SPLIT_REMINDER
const localPlayer = 'storabollar'

function sessionWithTeams () {
  const session = __test.createSessionState()
  __test.trackScoreboardTeam('scoreboard_team', {
    team: 'yellow',
    mode: 0,
    prefix: '\u00a7e',
    players: [localPlayer, 'galenballe']
  }, session, new Map())
  __test.trackScoreboardTeam('scoreboard_team', {
    team: 'red',
    mode: 0,
    prefix: '\u00a7c',
    players: ['Prigaditsa', 'enemyplayer']
  }, session, new Map())
  return session
}

function sessionWithSplitColorTeams () {
  const session = __test.createSessionState()
  __test.trackScoreboardTeam('scoreboard_team', {
    team: 'red-local',
    mode: 0,
    prefix: '\u00a7c',
    players: [localPlayer]
  }, session, new Map())
  __test.trackScoreboardTeam('scoreboard_team', {
    team: 'red-mate',
    mode: 0,
    prefix: '\u00a7c',
    players: ['galenballe', 'bloon_popper_380']
  }, session, new Map())
  __test.trackScoreboardTeam('scoreboard_team', {
    team: 'gray-noise',
    mode: 0,
    prefix: '\u00a77',
    players: [localPlayer, 'ImDarwin__']
  }, session, new Map())
  __test.trackScoreboardTeam('scoreboard_team', {
    team: 'blue-enemy',
    mode: 0,
    prefix: '\u00a79',
    players: ['X6I3']
  }, session, new Map())
  return session
}

function sessionWithBroadLobbyColorGroup () {
  const session = __test.createSessionState()
  __test.trackScoreboardTeam('scoreboard_team', {
    team: 'aqua-lobby',
    mode: 0,
    prefix: '\u00a7b',
    players: [
      localPlayer,
      'intitled',
      'da8dy',
      'knaall',
      'omyd',
      'Pyroxylins'
    ]
  }, session, new Map())
  return session
}

function splitContext (session, logs = []) {
  return {
    sessionState: session,
    localPlayerName: localPlayer,
    log: message => logs.push(message)
  }
}

function markGameStarted (state) {
  __test.withSplitReminderPacket('title', {
    text: JSON.stringify({ text: 'Protect your bed and destroy the enemy beds.' })
  }, state, settings, 500)
}

function setModeText (state, text) {
  __test.withSplitReminderChatComponent({ text }, state, settings, 250, splitContext(__test.createSessionState()))
}

function setScoreboardModeText (session, state, text) {
  __test.trackScoreboardScore({
    itemName: text,
    scoreName: 'sidebar',
    value: 1
  }, session)
  return __test.updateBedWarsModeFromScoreboard(session, state)
}

function setSplitScoreboardModeText (session, state, prefix, itemName, suffix) {
  __test.trackScoreboardScore({
    itemName,
    scoreName: 'sidebar',
    value: 1
  }, session)
  __test.trackScoreboardTeam('scoreboard_team', {
    team: 'mode-line',
    mode: 0,
    prefix,
    suffix,
    players: [itemName]
  }, session, new Map())
  return __test.updateBedWarsModeFromScoreboard(session, state)
}

assert.equal(__test.deathPlayerName('galenballe fell into the void.'), 'galenballe')
assert.equal(__test.deathPlayerName('Prigaditsa was killed by Zombie'), 'Prigaditsa')
assert.equal(__test.deathPlayerName('You have respawned!'), null)

const session = sessionWithTeams()
assert.equal(__test.localPlayerTeam(session, localPlayer).team, 'yellow')
assert.equal(__test.isLocalTeammateDeathText(
  'galenballe fell into the void.',
  settings,
  session,
  localPlayer
).match, true)
assert.equal(__test.isLocalTeammateDeathText(
  'Prigaditsa fell into the void.',
  settings,
  session,
  localPlayer
).match, false)

const splitColorSession = sessionWithSplitColorTeams()
assert.deepEqual(__test.localTeammateNames(splitColorSession, localPlayer), ['bloon_popper_380', 'galenballe', localPlayer])
const pregameState = __test.createSplitReminderState()
assert.deepEqual(__test.localTeammateNames(splitColorSession, localPlayer, pregameState), [])
assert.equal(__test.isLocalTeammateDeathText(
  'galenballe fell into the void.',
  settings,
  splitColorSession,
  localPlayer,
  pregameState
).match, false)
markGameStarted(pregameState)
assert.deepEqual(__test.localTeammateNames(splitColorSession, localPlayer, pregameState), ['bloon_popper_380', 'galenballe', localPlayer])
assert.equal(__test.isLocalTeammateDeathText(
  'galenballe fell into the void.',
  settings,
  splitColorSession,
  localPlayer
).match, true)
assert.equal(__test.isLocalTeammateDeathText(
  'X6I3 fell into the void.',
  settings,
  splitColorSession,
  localPlayer
).match, false)
assert.equal(__test.isLocalTeammateDeathText(
  'ImDarwin__ fell into the void.',
  settings,
  splitColorSession,
  localPlayer
).match, false)

const broadLobbySession = sessionWithBroadLobbyColorGroup()
assert.deepEqual(__test.localTeammateNames(broadLobbySession, localPlayer), [])
assert.equal(__test.isLocalTeammateDeathText(
  'intitled fell into the void.',
  settings,
  broadLobbySession,
  localPlayer
).match, false)

const startClearsPregameSession = sessionWithSplitColorTeams()
const startClearsPregameState = __test.createSplitReminderState()
__test.withSplitReminderPacket('title', {
  text: JSON.stringify({ text: 'Protect your bed and destroy the enemy beds.' })
}, startClearsPregameState, settings, 500, startClearsPregameSession)
assert.deepEqual(__test.localTeammateNames(startClearsPregameSession, localPlayer, startClearsPregameState), [])
__test.trackScoreboardTeam('scoreboard_team', {
  team: 'red-local',
  mode: 0,
  prefix: '\u00a7c',
  players: [localPlayer]
}, startClearsPregameSession, new Map())
__test.trackScoreboardTeam('scoreboard_team', {
  team: 'red-mate',
  mode: 0,
  prefix: '\u00a7c',
  players: ['galenballe']
}, startClearsPregameSession, new Map())
assert.deepEqual(__test.localTeammateNames(startClearsPregameSession, localPlayer, startClearsPregameState), ['galenballe', localPlayer])

const persistentSession = sessionWithSplitColorTeams()
const persistentState = __test.createSplitReminderState()
markGameStarted(persistentState)
assert.deepEqual(
  __test.localTeammateNames(persistentSession, localPlayer, persistentState),
  ['bloon_popper_380', 'galenballe', localPlayer]
)
__test.trackScoreboardTeam('scoreboard_team', {
  team: 'red-mate',
  mode: 4,
  players: ['galenballe']
}, persistentSession, new Map())
assert.deepEqual(
  __test.localTeammateNames(persistentSession, localPlayer, persistentState),
  ['bloon_popper_380', 'galenballe', localPlayer]
)
assert.equal(__test.isLocalTeammateDeathText(
  'bloon_popper_380 fell into the void.',
  settings,
  persistentSession,
  localPlayer,
  persistentState
).match, true)
__test.withSplitReminderChatComponent(
  { text: 'You will respawn in 5 seconds!' },
  persistentState,
  settings,
  1000,
  splitContext(persistentSession)
)
__test.withSplitReminderChatComponent(
  { text: 'galenballe fell into the void.' },
  persistentState,
  settings,
  1500,
  splitContext(persistentSession)
)
assert.equal(persistentState.splitPending, true)

const transientColorSession = __test.createSessionState()
const transientColorState = __test.createSplitReminderState()
markGameStarted(transientColorState)
__test.trackScoreboardTeam('scoreboard_team', {
  team: 'yellow-local',
  mode: 0,
  prefix: '\u00a7e',
  players: [localPlayer]
}, transientColorSession, new Map())
__test.trackScoreboardTeam('scoreboard_team', {
  team: 'yellow-team',
  mode: 0,
  prefix: '\u00a7e',
  players: ['Adam50555', 'Alek50555', 'kingcraft109']
}, transientColorSession, new Map())
assert.deepEqual(
  __test.localTeammateNames(transientColorSession, localPlayer, transientColorState),
  ['Adam50555', 'Alek50555', 'kingcraft109', localPlayer]
)
__test.trackScoreboardTeam('scoreboard_team', {
  team: 'yellow-local',
  mode: 1
}, transientColorSession, new Map())
__test.trackScoreboardTeam('scoreboard_team', {
  team: 'yellow-team',
  mode: 1
}, transientColorSession, new Map())
__test.trackScoreboardTeam('scoreboard_team', {
  team: 'gray-local',
  mode: 0,
  prefix: '\u00a77',
  players: [localPlayer]
}, transientColorSession, new Map())
assert.deepEqual(
  __test.localTeammateNames(transientColorSession, localPlayer, transientColorState),
  ['Adam50555', 'Alek50555', 'kingcraft109', localPlayer]
)
__test.withSplitReminderChatComponent(
  { text: 'You will respawn in 5 seconds!' },
  transientColorState,
  settings,
  1000,
  splitContext(transientColorSession)
)
__test.withSplitReminderChatComponent(
  { text: 'kingcraft109 fell into the void.' },
  transientColorState,
  settings,
  1500,
  splitContext(transientColorSession)
)
assert.equal(transientColorState.splitPending, true)

const foursSession = __test.createSessionState()
const foursState = __test.createSplitReminderState()
setModeText(foursState, 'Mode: 4v4v4v4')
markGameStarted(foursState)
__test.trackScoreboardTeam('scoreboard_team', {
  team: 'blue-local',
  mode: 0,
  prefix: '\u00a79',
  players: [localPlayer]
}, foursSession, new Map())
__test.trackScoreboardTeam('scoreboard_team', {
  team: 'blue-team',
  mode: 0,
  prefix: '\u00a79',
  players: ['leaciM_', 'IDisme']
}, foursSession, new Map())
assert.deepEqual(__test.localTeammateNames(foursSession, localPlayer, foursState, 5000), ['IDisme', 'leaciM_', localPlayer])
__test.trackScoreboardTeam('scoreboard_team', {
  team: 'blue-team',
  mode: 0,
  prefix: '\u00a79',
  players: ['leaciM_', 'IDisme', 'SupremFouf']
}, foursSession, new Map())
assert.deepEqual(__test.localTeammateNames(foursSession, localPlayer, foursState, 6000), ['IDisme', 'leaciM_', localPlayer, 'SupremFouf'])
__test.trackScoreboardTeam('scoreboard_team', {
  team: 'blue-team',
  mode: 0,
  prefix: '\u00a79',
  players: ['gh_etiger123', 'IDisme', 'leaciM_', 'SupremFouf']
}, foursSession, new Map())
assert.deepEqual(__test.localTeammateNames(foursSession, localPlayer, foursState, 7000), ['IDisme', 'leaciM_', localPlayer, 'SupremFouf'])

const observedFourSession = __test.createSessionState()
const observedFourState = __test.createSplitReminderState()
markGameStarted(observedFourState)
__test.trackScoreboardTeam('scoreboard_team', {
  team: 'blue-local',
  mode: 0,
  prefix: '\u00a79',
  players: [localPlayer]
}, observedFourSession, new Map())
__test.trackScoreboardTeam('scoreboard_team', {
  team: 'blue-team',
  mode: 0,
  prefix: '\u00a79',
  players: ['limpbizkitt', 'Smiley61']
}, observedFourSession, new Map())
assert.deepEqual(__test.localTeammateNames(observedFourSession, localPlayer, observedFourState, 1000), ['limpbizkitt', 'Smiley61', localPlayer])
__test.trackScoreboardTeam('scoreboard_team', {
  team: 'blue-team',
  mode: 0,
  prefix: '\u00a79',
  players: ['Camilk016', 'limpbizkitt', 'Smiley61']
}, observedFourSession, new Map())
assert.deepEqual(__test.localTeammateNames(observedFourSession, localPlayer, observedFourState, 2000), ['Camilk016', 'limpbizkitt', 'Smiley61', localPlayer])
__test.trackScoreboardTeam('scoreboard_team', {
  team: 'blue-team',
  mode: 0,
  prefix: '\u00a79',
  players: ['limpbizkitt']
}, observedFourSession, new Map())
assert.deepEqual(__test.localTeammateNames(observedFourSession, localPlayer, observedFourState, 6000), ['Camilk016', 'limpbizkitt', 'Smiley61', localPlayer])

const displayColorSession = __test.createSessionState()
const displayColorState = __test.createSplitReminderState()
markGameStarted(displayColorState)
__test.trackPlayerInfo({
  action: 0,
  data: [
    { name: 'FishHalo', uuid: 'fishhalo', displayName: '\u00a7cFishHalo' },
    { name: 'BlueOne', uuid: 'blue-one', displayName: '\u00a79BlueOne' },
    { name: 'BlueTwo', uuid: 'blue-two', displayName: '\u00a79BlueTwo' },
    { name: 'BlueThree', uuid: 'blue-three', displayName: '\u00a79BlueThree' },
    { name: 'BlueFour', uuid: 'blue-four', displayName: '\u00a79BlueFour' }
  ]
}, displayColorSession)
__test.trackScoreboardTeam('scoreboard_team', {
  team: 'red-local',
  mode: 0,
  prefix: '\u00a7c',
  players: [localPlayer, 'SupremFouf']
}, displayColorSession, new Map())
__test.trackScoreboardTeam('scoreboard_team', {
  team: 'red-display-name',
  mode: 0,
  players: ['FishHalo']
}, displayColorSession, new Map())
__test.trackScoreboardTeam('scoreboard_team', {
  team: 'blue-display-name',
  mode: 0,
  players: ['BlueOne', 'BlueTwo', 'BlueThree', 'BlueFour']
}, displayColorSession, new Map())
assert.deepEqual(__test.updateBedWarsModeFromScoreboard(displayColorSession, displayColorState), {
  label: '4v4v4v4',
  maxPlayers: 4
})
assert.deepEqual(
  __test.localTeammateNames(displayColorSession, localPlayer, displayColorState, 5000),
  ['FishHalo', localPlayer, 'SupremFouf']
)

const scoreboardModeSession = __test.createSessionState()
const scoreboardModeState = __test.createSplitReminderState()
markGameStarted(scoreboardModeState)
assert.deepEqual(setScoreboardModeText(scoreboardModeSession, scoreboardModeState, 'Bed Wars Doubles'), {
  label: 'Doubles',
  maxPlayers: 2
})
assert.equal(setScoreboardModeText(scoreboardModeSession, scoreboardModeState, 'Bed Wars Doubles'), null)
__test.trackScoreboardTeam('scoreboard_team', {
  team: 'red-local',
  mode: 0,
  prefix: '\u00a7c',
  players: [localPlayer]
}, scoreboardModeSession, new Map())
__test.trackScoreboardTeam('scoreboard_team', {
  team: 'red-team',
  mode: 0,
  prefix: '\u00a7c',
  players: ['kekokoa', '_Sefir']
}, scoreboardModeSession, new Map())
assert.deepEqual(__test.localTeammateNames(scoreboardModeSession, localPlayer, scoreboardModeState, 1000), ['kekokoa', localPlayer])

const splitScoreboardModeSession = __test.createSessionState()
const splitScoreboardModeState = __test.createSplitReminderState()
markGameStarted(splitScoreboardModeState)
assert.deepEqual(setSplitScoreboardModeText(
  splitScoreboardModeSession,
  splitScoreboardModeState,
  'Mode: ',
  '\u00a71',
  '4v4v4v4'
), {
  label: '4v4v4v4',
  maxPlayers: 4
})
__test.trackScoreboardTeam('scoreboard_team', {
  team: 'blue-local',
  mode: 0,
  prefix: '\u00a79',
  players: [localPlayer]
}, splitScoreboardModeSession, new Map())
__test.trackScoreboardTeam('scoreboard_team', {
  team: 'blue-team',
  mode: 0,
  prefix: '\u00a79',
  players: ['limpbizkitt', 'Smiley61', 'Camilk016', 'extraBlue']
}, splitScoreboardModeSession, new Map())
assert.deepEqual(
  __test.localTeammateNames(splitScoreboardModeSession, localPlayer, splitScoreboardModeState, 1000),
  ['Camilk016', 'limpbizkitt', 'Smiley61', localPlayer]
)

const activeModeLockSession = __test.createSessionState()
const activeModeLockState = __test.createSplitReminderState()
markGameStarted(activeModeLockState)
assert.deepEqual(setScoreboardModeText(activeModeLockSession, activeModeLockState, 'Mode: 4v4v4v4'), {
  label: '4v4v4v4',
  maxPlayers: 4
})
__test.trackScoreboardTeam('scoreboard_team', {
  team: 'red-local',
  mode: 0,
  prefix: '\u00a7c',
  players: [localPlayer]
}, activeModeLockSession, new Map())
__test.trackScoreboardTeam('scoreboard_team', {
  team: 'red-team',
  mode: 0,
  prefix: '\u00a7c',
  players: ['LoserGoodGame', 'SluzhuDrk', 'OVERRlDE']
}, activeModeLockSession, new Map())
assert.deepEqual(
  __test.localTeammateNames(activeModeLockSession, localPlayer, activeModeLockState, 1000),
  ['LoserGoodGame', 'OVERRlDE', 'SluzhuDrk', localPlayer]
)
__test.withSplitReminderPacket('title', {
  text: JSON.stringify({ text: 'Protect your bed and destroy the enemy beds.' })
}, activeModeLockState, settings, 2000, activeModeLockSession)
assert.equal(setScoreboardModeText(activeModeLockSession, activeModeLockState, 'Mode: 4v4v4v4'), null)
assert.deepEqual(
  __test.localTeammateNames(activeModeLockSession, localPlayer, activeModeLockState, 2200),
  ['LoserGoodGame', 'OVERRlDE', 'SluzhuDrk', localPlayer]
)
__test.withSplitReminderPacket('title', {
  text: JSON.stringify({ text: 'Protect your bed and destroy the enemy beds.' })
}, activeModeLockState, settings, 60000, activeModeLockSession)
assert.equal(setScoreboardModeText(activeModeLockSession, activeModeLockState, 'Mode: 4v4v4v4'), null)
assert.deepEqual(
  __test.localTeammateNames(activeModeLockSession, localPlayer, activeModeLockState, 60200),
  ['LoserGoodGame', 'OVERRlDE', 'SluzhuDrk', localPlayer]
)
__test.withSplitReminderChatComponent(
  { text: 'You are now on Red team' },
  activeModeLockState,
  settings,
  2000,
  splitContext(activeModeLockSession)
)
assert.deepEqual(
  __test.localTeammateNames(activeModeLockSession, localPlayer, activeModeLockState, 2500),
  ['LoserGoodGame', 'OVERRlDE', 'SluzhuDrk', localPlayer]
)
assert.equal(setScoreboardModeText(activeModeLockSession, activeModeLockState, 'Solo'), null)
__test.trackScoreboardTeam('scoreboard_team', {
  team: 'red-team',
  mode: 0,
  prefix: '\u00a7c',
  players: ['LoserGoodGame']
}, activeModeLockSession, new Map())
assert.deepEqual(
  __test.localTeammateNames(activeModeLockSession, localPlayer, activeModeLockState, 3000),
  ['LoserGoodGame', 'OVERRlDE', 'SluzhuDrk', localPlayer]
)

const newGameStartSession = __test.createSessionState()
const newGameStartState = __test.createSplitReminderState()
markGameStarted(newGameStartState)
assert.deepEqual(setScoreboardModeText(newGameStartSession, newGameStartState, 'Mode: 4v4v4v4'), {
  label: '4v4v4v4',
  maxPlayers: 4
})
__test.trackScoreboardTeam('scoreboard_team', {
  team: 'red-local',
  mode: 0,
  prefix: '\u00a7c',
  players: [localPlayer]
}, newGameStartSession, new Map())
__test.trackScoreboardTeam('scoreboard_team', {
  team: 'red-team',
  mode: 0,
  prefix: '\u00a7c',
  players: ['OldMate']
}, newGameStartSession, new Map())
assert.deepEqual(
  __test.localTeammateNames(newGameStartSession, localPlayer, newGameStartState, 1000),
  ['OldMate', localPlayer]
)
__test.withSplitReminderPacket('title', {
  text: JSON.stringify({ text: 'Protect your bed and destroy the enemy beds.' })
}, newGameStartState, settings, 60000, newGameStartSession)
assert.deepEqual(
  __test.localTeammateNames(newGameStartSession, localPlayer, newGameStartState, 60200),
  ['OldMate', localPlayer]
)
__test.withSplitReminderChatComponent(
  { text: 'The game starts in 5 seconds!' },
  newGameStartState,
  settings,
  70000,
  splitContext(newGameStartSession)
)
__test.withSplitReminderPacket('title', {
  text: JSON.stringify({ text: 'Protect your bed and destroy the enemy beds.' })
}, newGameStartState, settings, 76000, newGameStartSession)
assert.deepEqual(
  __test.localTeammateNames(newGameStartSession, localPlayer, newGameStartState, 76200),
  []
)
__test.trackScoreboardTeam('scoreboard_team', {
  team: 'yellow-local',
  mode: 0,
  prefix: '\u00a7e',
  players: [localPlayer]
}, newGameStartSession, new Map())
__test.trackScoreboardTeam('scoreboard_team', {
  team: 'yellow-team',
  mode: 0,
  prefix: '\u00a7e',
  players: ['NewMate']
}, newGameStartSession, new Map())
assert.deepEqual(
  __test.localTeammateNames(newGameStartSession, localPlayer, newGameStartState, 77000),
  ['NewMate', localPlayer]
)

const threesSession = __test.createSessionState()
const threesState = __test.createSplitReminderState()
setModeText(threesState, 'Mode: 3v3v3v3')
markGameStarted(threesState)
__test.trackScoreboardTeam('scoreboard_team', {
  team: 'green-local',
  mode: 0,
  prefix: '\u00a7a',
  players: [localPlayer]
}, threesSession, new Map())
__test.trackScoreboardTeam('scoreboard_team', {
  team: 'green-team',
  mode: 0,
  prefix: '\u00a7a',
  players: ['CoLaGyul', 'Kajez']
}, threesSession, new Map())
assert.deepEqual(__test.localTeammateNames(threesSession, localPlayer, threesState, 5000), ['CoLaGyul', 'Kajez', localPlayer])
__test.trackScoreboardTeam('scoreboard_team', {
  team: 'green-team',
  mode: 0,
  prefix: '\u00a7a',
  players: ['CoLaGyul', 'Kajez', 'ZakSinghwalker']
}, threesSession, new Map())
assert.deepEqual(__test.localTeammateNames(threesSession, localPlayer, threesState, 6000), ['CoLaGyul', 'Kajez', localPlayer])

const doublesSession = __test.createSessionState()
const doublesState = __test.createSplitReminderState()
setModeText(doublesState, 'Bed Wars Doubles')
markGameStarted(doublesState)
__test.trackScoreboardTeam('scoreboard_team', {
  team: 'red-local',
  mode: 0,
  prefix: '\u00a7c',
  players: [localPlayer]
}, doublesSession, new Map())
__test.trackScoreboardTeam('scoreboard_team', {
  team: 'red-team',
  mode: 0,
  prefix: '\u00a7c',
  players: ['kekokoa']
}, doublesSession, new Map())
assert.deepEqual(__test.localTeammateNames(doublesSession, localPlayer, doublesState, 5000), ['kekokoa', localPlayer])
__test.trackScoreboardTeam('scoreboard_team', {
  team: 'red-team',
  mode: 0,
  prefix: '\u00a7c',
  players: ['kekokoa', '_Sefir']
}, doublesSession, new Map())
assert.deepEqual(__test.localTeammateNames(doublesSession, localPlayer, doublesState, 6000), ['kekokoa', localPlayer])

const tabLetterSession = __test.createSessionState()
const tabLetterState = __test.createSplitReminderState()
setModeText(tabLetterState, 'Mode: 4v4v4v4')
markGameStarted(tabLetterState)
__test.trackScoreboardTeam('scoreboard_team', {
  team: 'yellow-local',
  mode: 0,
  prefix: '\u00a7eY ',
  players: [localPlayer]
}, tabLetterSession, new Map())
__test.trackScoreboardTeam('scoreboard_team', {
  team: 'yellow-one',
  mode: 0,
  prefix: '\u00a7eY ',
  players: ['HasanSyed22']
}, tabLetterSession, new Map())
__test.trackScoreboardTeam('scoreboard_team', {
  team: 'yellow-two',
  mode: 0,
  prefix: '\u00a7eY ',
  players: ['Lambo67', 'raskolnikov333']
}, tabLetterSession, new Map())
__test.trackScoreboardTeam('scoreboard_team', {
  team: 'same-color-wrong-letter',
  mode: 0,
  prefix: '\u00a7eR ',
  players: ['FakeYellowEnemy']
}, tabLetterSession, new Map())
assert.deepEqual(
  __test.localTeammateNames(tabLetterSession, localPlayer, tabLetterState, 5000),
  ['HasanSyed22', 'Lambo67', 'raskolnikov333', localPlayer]
)
assert.equal(__test.isLocalTeammateDeathText(
  'Lambo67 fell into the void.',
  settings,
  tabLetterSession,
  localPlayer,
  tabLetterState
).match, true)
assert.equal(__test.isLocalTeammateDeathText(
  'FakeYellowEnemy fell into the void.',
  settings,
  tabLetterSession,
  localPlayer,
  tabLetterState
).match, false)

const tabDisplaySession = __test.createSessionState()
const tabDisplayState = __test.createSplitReminderState()
setModeText(tabDisplayState, 'Mode: 4v4v4v4')
markGameStarted(tabDisplayState)
__test.trackScoreboardTeam('scoreboard_team', {
  team: 'display-local',
  mode: 0,
  prefix: '',
  players: [localPlayer]
}, tabDisplaySession, new Map())
__test.trackPlayerInfo({
  action: 'add_player',
  data: [
    { uuid: '00000000-0000-0000-0000-000000000001', name: localPlayer, displayName: JSON.stringify({ text: `Y ${localPlayer}` }) },
    { uuid: '00000000-0000-0000-0000-000000000002', name: 'DisplayMate', displayName: JSON.stringify({ text: 'Y DisplayMate' }) },
    { uuid: '00000000-0000-0000-0000-000000000003', name: 'DisplayEnemy', displayName: JSON.stringify({ text: 'R DisplayEnemy' }) }
  ]
}, tabDisplaySession)
assert.deepEqual(
  __test.localTeammateNames(tabDisplaySession, localPlayer, tabDisplayState, 5000),
  ['DisplayMate', localPlayer]
)

const nextGameSession = sessionWithSplitColorTeams()
const nextGameState = __test.createSplitReminderState()
markGameStarted(nextGameState)
assert.deepEqual(
  __test.localTeammateNames(nextGameSession, localPlayer, nextGameState),
  ['bloon_popper_380', 'galenballe', localPlayer]
)
__test.withSplitReminderChatComponent(
  { text: 'VICTORY!' },
  nextGameState,
  settings,
  2000,
  splitContext(nextGameSession)
)
assert.deepEqual(__test.localTeammateNames(nextGameSession, localPlayer, nextGameState), [])
markGameStarted(nextGameState)
__test.trackScoreboardTeam('scoreboard_team', {
  team: 'red-local',
  mode: 0,
  prefix: '\u00a7c',
  players: [localPlayer]
}, nextGameSession, new Map())
__test.trackScoreboardTeam('scoreboard_team', {
  team: 'red-mate',
  mode: 0,
  prefix: '\u00a7c',
  players: ['X6I3']
}, nextGameSession, new Map())
assert.deepEqual(
  __test.localTeammateNames(nextGameSession, localPlayer, nextGameState),
  [localPlayer, 'X6I3']
)
assert.equal(__test.isLocalTeammateDeathText(
  'galenballe fell into the void.',
  settings,
  nextGameSession,
  localPlayer,
  nextGameState
).match, false)
assert.equal(__test.isLocalTeammateDeathText(
  'X6I3 fell into the void.',
  settings,
  nextGameSession,
  localPlayer,
  nextGameState
).match, true)

const state = __test.createSplitReminderState()
markGameStarted(state)
const death = __test.withSplitReminderChatComponent(
  { text: 'You will respawn in 5 seconds!' },
  state,
  settings,
  1000,
  splitContext(session)
)
assert.equal(death.text, 'You will respawn in 5 seconds!')
assert.equal(state.respawning, true)
assert.equal(state.splitPending, false)

const teammateVoid = __test.withSplitReminderChatComponent(
  { text: 'galenballe fell into the void.' },
  state,
  settings,
  1500,
  splitContext(session)
)
assert.equal(teammateVoid.text, 'galenballe fell into the void.')
assert.equal(state.splitPending, true)
assert.match(state.lastTrigger, /galenballe fell into the void/)

__test.withSplitReminderChatComponent(
  { text: 'You will respawn in 4 seconds!' },
  state,
  settings,
  1600,
  splitContext(session)
)
assert.equal(state.splitPending, true)
assert.match(state.lastTrigger, /galenballe fell into the void/)

const chatRespawn = __test.withSplitReminderChatComponent(
  { text: 'You have respawned!' },
  state,
  settings,
  1900,
  splitContext(session)
)
assert.equal(chatRespawn.text, 'You have respawned!')
assert.equal(state.respawning, false)
assert.equal(state.splitPending, true)

const sentenceTitle = __test.withSplitReminderPacket('title', {
  text: JSON.stringify({ text: 'You have respawned!' })
}, state, settings, 1950)
assert.deepEqual(JSON.parse(sentenceTitle.text), { text: 'You have respawned!' })
assert.equal(state.splitPending, true)

const titlePacket = __test.withSplitReminderPacket('title', {
  text: JSON.stringify({ text: 'RESPAWNED!', color: 'green', bold: true })
}, state, settings, 7001)
assert.deepEqual(JSON.parse(titlePacket.text), { text: 'SPLIT!', color: 'green', bold: true })
assert.equal(state.splitPending, false)
assert.equal(state.respawning, false)

const enemyLogs = []
const enemyState = __test.createSplitReminderState()
markGameStarted(enemyState)
__test.withSplitReminderChatComponent(
  { text: 'You will respawn in 5 seconds!' },
  enemyState,
  settings,
  1000,
  splitContext(session, enemyLogs)
)
__test.withSplitReminderChatComponent(
  { text: 'Prigaditsa fell into the void.' },
  enemyState,
  settings,
  1500,
  splitContext(session, enemyLogs)
)
assert.equal(enemyState.splitPending, false)
assert.match(enemyLogs.join('\n'), /Ignored split trigger from non-teammate Prigaditsa/)

const localDeathState = __test.createSplitReminderState()
markGameStarted(localDeathState)
__test.withSplitReminderChatComponent(
  { text: `${localPlayer} fell into the void.` },
  localDeathState,
  settings,
  1000,
  splitContext(session)
)
assert.equal(localDeathState.respawning, false)
assert.equal(localDeathState.splitPending, false)

const earlyTeammateDeathState = __test.createSplitReminderState()
markGameStarted(earlyTeammateDeathState)
__test.withSplitReminderChatComponent(
  { text: 'galenballe fell into the void.' },
  earlyTeammateDeathState,
  settings,
  900,
  splitContext(session)
)
assert.equal(earlyTeammateDeathState.splitPending, false)
__test.withSplitReminderChatComponent(
  { text: 'You will respawn in 5 seconds!' },
  earlyTeammateDeathState,
  settings,
  1000,
  splitContext(session)
)
assert.equal(earlyTeammateDeathState.splitPending, true)
assert.match(earlyTeammateDeathState.lastTrigger, /galenballe fell into the void/)
const earlyTitlePacket = __test.withSplitReminderPacket('title', {
  text: JSON.stringify({ text: 'RESPAWNED!', color: 'green' })
}, earlyTeammateDeathState, settings, 2000)
assert.deepEqual(JSON.parse(earlyTitlePacket.text), { text: 'SPLIT!', color: 'green' })

const staleEarlyDeathState = __test.createSplitReminderState()
markGameStarted(staleEarlyDeathState)
__test.withSplitReminderChatComponent(
  { text: 'galenballe fell into the void.' },
  staleEarlyDeathState,
  settings,
  1000,
  splitContext(session)
)
__test.withSplitReminderChatComponent(
  { text: 'You will respawn in 5 seconds!' },
  staleEarlyDeathState,
  settings,
  5000,
  splitContext(session)
)
assert.equal(staleEarlyDeathState.splitPending, false)

const missingTeamLogs = []
const missingTeamState = __test.createSplitReminderState()
markGameStarted(missingTeamState)
__test.withSplitReminderChatComponent(
  { text: 'You will respawn in 5 seconds!' },
  missingTeamState,
  settings,
  1000,
  splitContext(__test.createSessionState(), missingTeamLogs)
)
__test.withSplitReminderChatComponent(
  { text: 'galenballe fell into the void.' },
  missingTeamState,
  settings,
  1500,
  splitContext(__test.createSessionState(), missingTeamLogs)
)
assert.equal(missingTeamState.splitPending, false)
assert.match(missingTeamLogs.join('\n'), /local team not detected/)

const arrayTitleState = __test.createSplitReminderState()
markGameStarted(arrayTitleState)
__test.withSplitReminderChatComponent(
  { text: 'You will respawn in 5 seconds!' },
  arrayTitleState,
  settings,
  1000,
  splitContext(session)
)
__test.withSplitReminderChatComponent(
  { text: 'galenballe fell into the void.' },
  arrayTitleState,
  settings,
  1500,
  splitContext(session)
)
const arrayTitlePacket = __test.withSplitReminderPacket('title', {
  text: JSON.stringify([{ text: '', color: 'green' }, { text: 'RESPAWNED!' }])
}, arrayTitleState, settings, 2000)
assert.deepEqual(JSON.parse(arrayTitlePacket.text), { text: 'SPLIT!' })

const nestedTitleState = __test.createSplitReminderState()
markGameStarted(nestedTitleState)
__test.withSplitReminderChatComponent(
  { text: 'You will respawn in 5 seconds!' },
  nestedTitleState,
  settings,
  1000,
  splitContext(session)
)
__test.withSplitReminderChatComponent(
  { text: 'galenballe fell into the void.' },
  nestedTitleState,
  settings,
  1500,
  splitContext(session)
)
const nestedTitlePacket = __test.withSplitReminderPacket('title', {
  action: 0,
  component: JSON.stringify({ text: 'RESPAWNED!' })
}, nestedTitleState, settings, 2000)
assert.deepEqual(JSON.parse(nestedTitlePacket.component), { text: 'SPLIT!' })
assert.equal(nestedTitleState.splitPending, false)

assert.equal(__test.packetHasRespawnedTitleText({
  mystery: JSON.stringify({ text: 'RESPAWNED!' })
}, settings), true)
const forcedTitle = __test.forcedSplitTitlePacket('title', { action: 2, fadeIn: 0, stay: 20, fadeOut: 0 }, settings)
assert.equal(forcedTitle.action, 0)
assert.deepEqual(JSON.parse(forcedTitle.text), { text: 'SPLIT!', color: 'green' })
assert.deepEqual(__test.splitTitleTimingPacket('title'), {
  action: 2,
  fadeIn: 0,
  stay: 60,
  fadeOut: 10
})
assert.equal(__test.splitTitleTimingPacket('set_title_text'), null)
const splitSubtitle = __test.splitTitleSubtitlePacket('title')
assert.equal(splitSubtitle.action, 1)
assert.deepEqual(JSON.parse(splitSubtitle.text), { text: 'Split with your teamate.', color: 'yellow' })
assert.equal(__test.splitTitleSubtitlePacket('set_title_text'), null)
assert.deepEqual(JSON.parse(__test.splitTitleSubtitlePacket('set_title_subtitle').text), { text: 'Split with your teamate.', color: 'yellow' })

const unknownPacketState = __test.createSplitReminderState()
markGameStarted(unknownPacketState)
__test.withSplitReminderChatComponent(
  { text: 'You will respawn in 5 seconds!' },
  unknownPacketState,
  settings,
  1000,
  splitContext(session)
)
__test.withSplitReminderChatComponent(
  { text: 'galenballe fell into the void.' },
  unknownPacketState,
  settings,
  1500,
  splitContext(session)
)
const unknownPacket = __test.withSplitReminderUnknownPacket({
  nested: {
    component: JSON.stringify({ text: 'RESPAWNED!', color: 'green' })
  }
}, unknownPacketState, settings, 2000)
assert.equal(unknownPacket.changed, true)
assert.deepEqual(JSON.parse(unknownPacket.packet.nested.component), { text: 'SPLIT!', color: 'green' })
assert.equal(unknownPacketState.splitPending, false)

const noSplit = __test.createSplitReminderState()
markGameStarted(noSplit)
__test.withSplitReminderChatComponent(
  { text: 'You will respawn in 5 seconds!' },
  noSplit,
  settings,
  1000,
  splitContext(session)
)
const normalTitle = __test.withSplitReminderPacket('title', {
  text: JSON.stringify({ text: 'RESPAWNED!', color: 'green' })
}, noSplit, settings, 2000)
assert.deepEqual(JSON.parse(normalTitle.text), { text: 'RESPAWNED!', color: 'green' })

const disabled = __test.createSplitReminderState()
const disabledResult = __test.withSplitReminderPacket(
  'title',
  { text: JSON.stringify({ text: 'RESPAWNED!' }) },
  disabled,
  { ...settings, enabled: false },
  1000
)
assert.deepEqual(JSON.parse(disabledResult.text), { text: 'RESPAWNED!' })
