const assert = require('assert')
const mc = require('minecraft-protocol')
const {
  APOLLO_JSON_CHANNEL,
  apolloChannelRegistrationPacket,
  apolloJsonPacket,
  apolloUuid,
  enableApolloNametagMessage,
  overrideApolloNametagMessage,
  packetRegistersApollo,
  packetSignalsLunarClient,
  packetUnregistersApollo,
  resetAllApolloNametagsMessage,
  resetApolloNametagMessage
} = require('../dist/apollo')
const { __test } = require('../dist/index')

const uuid = '00112233-4455-6677-8899-aabbccddeeff'
const uuidParts = apolloUuid(uuid)
const reconstructedUuid = ((BigInt(uuidParts.high64) << 64n) | BigInt(uuidParts.low64))
  .toString(16)
  .padStart(32, '0')
assert.equal(reconstructedUuid, uuid.replace(/-/g, ''))
assert.throws(() => apolloUuid('not-a-uuid'), /Invalid Minecraft UUID/)

assert.equal(packetRegistersApollo({
  channel: 'REGISTER',
  data: Buffer.from('FML|HS\0lunar:apollo\0Lunar-Client')
}), true)
assert.equal(packetRegistersApollo({
  channel: 'minecraft:register',
  data: ['brand', 'lunar:apollo']
}), true)
assert.equal(packetRegistersApollo({ channel: 'lunar:apollo', data: Buffer.alloc(0) }), true)
assert.equal(packetRegistersApollo({ channel: 'REGISTER', data: Buffer.from('FML|HS') }), false)
assert.equal(packetUnregistersApollo({ channel: 'UNREGISTER', data: Buffer.from('lunar:apollo') }), true)
assert.equal(packetUnregistersApollo({ channel: 'lunar:apollo', data: Buffer.alloc(0) }), false)
assert.equal(packetSignalsLunarClient({
  channel: 'MC|Brand',
  data: Buffer.concat([Buffer.from([24]), Buffer.from('lunarclient:v2.12.0-2349')])
}), true)
assert.equal(packetSignalsLunarClient({
  channel: 'minecraft:brand',
  data: 'lunarclient:v2.12.0-2349,fabric'
}), true)
assert.equal(packetSignalsLunarClient({ channel: 'MC|Brand', data: Buffer.from('vanilla') }), false)

const registration = apolloChannelRegistrationPacket()
assert.equal(registration.channel, 'REGISTER')
assert.deepEqual(
  registration.data.toString('utf8').split('\0'),
  ['lunar:apollo', APOLLO_JSON_CHANNEL]
)

const enableMessage = enableApolloNametagMessage()
assert.equal(enableMessage['@type'], 'type.googleapis.com/lunarclient.apollo.configurable.v1.OverrideConfigurableSettingsMessage')
assert.deepEqual(enableMessage.configurable_settings, [{ apollo_module: 'nametag', enable: true }])

const line = { text: '', extra: [{ text: '[MVP+] ', color: 'aqua' }, { text: 'Bollen', color: 'blue' }] }
const overrideMessage = overrideApolloNametagMessage(uuid, line)
assert.equal(overrideMessage['@type'], 'type.googleapis.com/lunarclient.apollo.nametag.v1.OverrideNametagMessage')
assert.deepEqual(overrideMessage.player_uuid, uuidParts)
assert.deepEqual(JSON.parse(overrideMessage.adventure_json_lines[0]), line)
const healthLine = { text: '', extra: [{ text: '20', color: 'white' }, { text: ' \u2764', color: 'red' }] }
const multiLineOverride = overrideApolloNametagMessage(uuid, [healthLine, line])
assert.equal(multiLineOverride.adventure_json_lines.length, 2)
assert.deepEqual(JSON.parse(multiLineOverride.adventure_json_lines[0]), healthLine)
assert.deepEqual(JSON.parse(multiLineOverride.adventure_json_lines[1]), line)
const heartPacket = apolloJsonPacket(multiLineOverride)
const heartPacketText = heartPacket.data.toString('ascii')
assert.match(heartPacketText, /\\u2764/)
assert.equal(heartPacket.data.includes(Buffer.from([0xe2, 0x9d, 0xa4])), false)
assert.deepEqual(
  JSON.parse(JSON.parse(heartPacketText).adventure_json_lines[0]),
  healthLine
)
assert.equal(resetApolloNametagMessage(uuid)['@type'], 'type.googleapis.com/lunarclient.apollo.nametag.v1.ResetNametagMessage')
assert.equal(resetAllApolloNametagsMessage()['@type'], 'type.googleapis.com/lunarclient.apollo.nametag.v1.ResetNametagsMessage')

for (const packet of [registration, apolloJsonPacket(overrideMessage)]) {
  const serializer = mc.createSerializer({ state: mc.states.PLAY, isServer: true, version: '1.8.8' })
  const deserializer = mc.createDeserializer({ state: mc.states.PLAY, isServer: false, version: '1.8.8' })
  const buffer = serializer.createPacketBuffer({ name: 'custom_payload', params: packet })
  const parsed = deserializer.parsePacketBuffer(buffer).data
  assert.equal(parsed.name, 'custom_payload')
  assert.equal(parsed.params.channel, packet.channel)
  assert.deepEqual(parsed.params.data, packet.data)
}

const nicknames = new Map([['998r', 'Bollen']])
const state = __test.createSessionState()
const profile = {
  uuid,
  name: '998r',
  properties: [{ name: 'textures', value: 'real-profile-data' }],
  gamemode: 0,
  ping: 42,
  displayName: null
}
__test.trackPlayerInfo({ action: 'add_player', data: [profile] }, state)
__test.trackScoreboardTeam('scoreboard_team', {
  team: 'ranked-blue-player',
  mode: 0,
  prefix: '\u00a7b[MVP+] \u00a79',
  suffix: '\u00a77 [S1]',
  players: ['998r']
}, state, new Map())

const rewrittenTab = __test.withNicknamePlayerInfo({ action: 'add_player', data: [profile] }, nicknames, state)
const tabText = __test.replaceNamesInChat(JSON.parse(rewrittenTab.data[0].displayName), new Map())
const flatten = component => {
  if (typeof component === 'string') return component
  if (Array.isArray(component)) return component.map(flatten).join('')
  if (!component || typeof component !== 'object') return ''
  return String(component.text || '') + (Array.isArray(component.extra) ? component.extra.map(flatten).join('') : '')
}
assert.equal(flatten(tabText), '[MVP+] Bollen [S1]')
assert.equal(rewrittenTab.data[0].name, '998r')
assert.deepEqual(rewrittenTab.data[0].properties, profile.properties)

const chat = {
  text: '',
  extra: [
    { text: '[MVP+] ', color: 'aqua', bold: true },
    { text: '998r', color: 'blue' },
    { text: ': hello', color: 'white' }
  ]
}
const rewrittenChat = __test.replaceNamesInChat(chat, nicknames)
assert.equal(rewrittenChat.extra[0].text, '[MVP+] ')
assert.equal(rewrittenChat.extra[0].color, 'aqua')
assert.equal(rewrittenChat.extra[0].bold, true)
assert.equal(rewrittenChat.extra[1].text, 'Bollen')
assert.equal(rewrittenChat.extra[1].color, 'blue')
assert.equal(rewrittenChat.extra[2].text, ': hello')

const nametag = __test.localPlayerNametagComponent(profile, nicknames, state)
assert.equal(flatten(nametag), '[MVP+] Bollen [S1]')

const writes = []
__test.refreshNicknameTabPlayers({
  write (name, params) {
    writes.push({ name, params })
  }
}, state, nicknames, ['998r'])
assert.equal(writes.length, 1)
assert.equal(writes[0].name, 'player_info')
assert.equal(flatten(JSON.parse(writes[0].params.data[0].displayName)), '[MVP+] Bollen [S1]')

writes.length = 0
__test.refreshApolloNametags({
  write (name, params) {
    writes.push({ name, params })
  }
}, state, nicknames, '998r')
assert.equal(writes.length, 1)
assert.equal(writes[0].name, 'custom_payload')
assert.equal(writes[0].params.channel, APOLLO_JSON_CHANNEL)
const sentOverride = JSON.parse(writes[0].params.data.toString('utf8'))
assert.equal(sentOverride['@type'], 'type.googleapis.com/lunarclient.apollo.nametag.v1.OverrideNametagMessage')
assert.equal(flatten(JSON.parse(sentOverride.adventure_json_lines[0])), '[MVP+] Bollen [S1]')

__test.trackScoreboardDisplayObjective({ position: 2, name: 'health' }, state)
__test.trackScoreboardScore({
  itemName: '998r',
  action: 0,
  scoreName: 'health',
  value: 20
}, state)

const nametagLines = __test.localPlayerNametagLines(profile, nicknames, state)
assert.equal(nametagLines.length, 2)
assert.deepEqual(nametagLines[0], healthLine)
assert.equal(flatten(nametagLines[1]), '[MVP+] Bollen [S1]')

writes.length = 0
__test.refreshApolloNametags({
  write (name, params) {
    writes.push({ name, params })
  }
}, state, nicknames, '998r')
const sentHealthOverride = JSON.parse(writes[0].params.data.toString('utf8'))
assert.equal(sentHealthOverride.adventure_json_lines.length, 2)
assert.deepEqual(JSON.parse(sentHealthOverride.adventure_json_lines[0]), healthLine)
assert.equal(flatten(JSON.parse(sentHealthOverride.adventure_json_lines[1])), '[MVP+] Bollen [S1]')

__test.trackScoreboardScore({
  itemName: '998r',
  action: 0,
  scoreName: 'health',
  value: 14
}, state)
assert.equal(flatten(__test.localPlayerNametagLines(profile, nicknames, state)[0]), '14 \u2764')

__test.trackScoreboardObjective({ name: 'health', action: 1 }, state)
assert.equal(__test.localPlayerNametagLines(profile, nicknames, state).length, 1)
