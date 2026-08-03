const assert = require('assert')
const { __test } = require('../dist/index')
const { defaultAppConfig } = require('../dist/appConfig')

assert.deepEqual(__test.parseSettingCommand('/setting'), { action: 'list' })
assert.deepEqual(__test.parseSettingCommand('/setting list'), { action: 'list' })
assert.deepEqual(
  __test.parseSettingCommand('/setting bedwars.tablist.show_respawn_timer'),
  {
    action: 'change',
    path: 'bedwars.tablist.show_respawn_timer',
    value: null
  }
)
assert.deepEqual(
  __test.parseSettingCommand('/setting respawn_timer off'),
  {
    action: 'change',
    path: 'respawn_timer',
    value: false
  }
)
assert.deepEqual(
  __test.parseSettingCommand('/setting split on'),
  {
    action: 'change',
    path: 'split',
    value: true
  }
)
assert.deepEqual(__test.parseSettingCommand('/setting split maybe'), { action: 'help' })
assert.equal(__test.parseSettingCommand('/msg setting hello'), null)

assert.equal(
  __test.canonicalSettingPath('RESPAWN_TIMER'),
  'bedwars.tablist.show_respawn_timer'
)
assert.equal(__test.canonicalSettingPath('unknown'), null)
assert.equal(__test.canonicalSettingPath('blockhit'), 'qol.blockhit_sound')
assert.equal(__test.canonicalSettingPath('obby'), 'bedwars.obsidian_detector')

const initial = defaultAppConfig()
assert.equal(
  __test.localSettingValue(initial, 'bedwars.tablist.show_respawn_timer'),
  true
)

const disabledTimer = __test.changeLocalSetting(
  initial,
  'bedwars.tablist.show_respawn_timer',
  false
)
assert.equal(disabledTimer.oldValue, true)
assert.equal(disabledTimer.newValue, false)
assert.equal(disabledTimer.config.bedWars.respawnTimerEnabled, false)
assert.equal(initial.bedWars.respawnTimerEnabled, true)
assert.equal(initial.qol.blockHitSoundEnabled, true)
assert.equal(initial.bedWars.obsidianDetectorEnabled, true)
assert.equal(initial.bedWars.obsidianDetectorMode, 'both')

const enabledTimer = __test.changeLocalSetting(
  disabledTimer.config,
  'respawn_timer',
  null
)
assert.equal(enabledTimer.newValue, true)
assert.equal(enabledTimer.config.bedWars.respawnTimerEnabled, true)

const disabledSplit = __test.changeLocalSetting(initial, 'split', null)
assert.equal(disabledSplit.path, 'qol.split_reminder')
assert.equal(disabledSplit.oldValue, true)
assert.equal(disabledSplit.newValue, false)
assert.equal(disabledSplit.config.splitReminder.enabled, false)

const disabledBlockHit = __test.changeLocalSetting(initial, 'blockhit', false)
assert.equal(disabledBlockHit.path, 'qol.blockhit_sound')
assert.equal(disabledBlockHit.oldValue, true)
assert.equal(disabledBlockHit.newValue, false)
assert.equal(disabledBlockHit.config.qol.blockHitSoundEnabled, false)

const disabledObsidianDetector = __test.changeLocalSetting(initial, 'obby', false)
assert.equal(disabledObsidianDetector.path, 'bedwars.obsidian_detector')
assert.equal(disabledObsidianDetector.oldValue, true)
assert.equal(disabledObsidianDetector.newValue, false)
assert.equal(disabledObsidianDetector.config.bedWars.obsidianDetectorEnabled, false)

assert.equal(__test.changeLocalSetting(initial, 'unknown', null), null)
