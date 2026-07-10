export const APOLLO_DETECTION_CHANNEL = 'lunar:apollo'
export const APOLLO_JSON_CHANNEL = 'apollo:json'

const REGISTER_CHANNELS = new Set(['register', 'minecraft:register'])
const UNREGISTER_CHANNELS = new Set(['unregister', 'minecraft:unregister'])

export type ApolloJsonMessage = Record<string, unknown>

function pluginChannelNames(data: unknown): string[] {
  if (Array.isArray(data)) {
    return data.flatMap(pluginChannelNames)
  }

  if (Buffer.isBuffer(data)) {
    return data.toString('utf8').split('\0').map(channel => channel.trim()).filter(Boolean)
  }

  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
      .toString('utf8')
      .split('\0')
      .map(channel => channel.trim())
      .filter(Boolean)
  }

  if (typeof data === 'string') {
    return data.split('\0').map(channel => channel.trim()).filter(Boolean)
  }

  return []
}

function registrationContains(packet: any, expectedChannel: string, registerChannels: Set<string>, directMessage = false): boolean {
  const packetChannel = String(packet?.channel || '').toLowerCase()
  if (directMessage && packetChannel === expectedChannel) return true
  if (!registerChannels.has(packetChannel)) return false

  return pluginChannelNames(packet?.data)
    .some(channel => channel.toLowerCase() === expectedChannel)
}

export function packetRegistersApollo(packet: any): boolean {
  return registrationContains(packet, APOLLO_DETECTION_CHANNEL, REGISTER_CHANNELS, true)
}

export function packetSignalsLunarClient(packet: any): boolean {
  if (packetRegistersApollo(packet)) return true

  const channel = String(packet?.channel || '').toLowerCase()
  if (channel !== 'mc|brand' && channel !== 'minecraft:brand') return false

  return pluginChannelNames(packet?.data)
    .some(value => /lunarclient(?:\s|:|,|$)/i.test(value))
}

export function packetUnregistersApollo(packet: any): boolean {
  return registrationContains(packet, APOLLO_DETECTION_CHANNEL, UNREGISTER_CHANNELS)
}

export function apolloChannelRegistrationPacket(): { channel: string; data: Buffer } {
  return {
    channel: 'REGISTER',
    data: Buffer.from(`${APOLLO_DETECTION_CHANNEL}\0${APOLLO_JSON_CHANNEL}`, 'utf8')
  }
}

export function apolloUuid(uuid: unknown): { high64: string; low64: string } {
  const hex = String(uuid || '').replace(/-/g, '').toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(hex)) {
    throw new Error(`Invalid Minecraft UUID: ${String(uuid)}`)
  }

  const value = BigInt(`0x${hex}`)
  const mask = (1n << 64n) - 1n
  return {
    high64: (value >> 64n).toString(10),
    low64: (value & mask).toString(10)
  }
}

export function enableApolloNametagMessage(): ApolloJsonMessage {
  return {
    '@type': 'type.googleapis.com/lunarclient.apollo.configurable.v1.OverrideConfigurableSettingsMessage',
    configurable_settings: [{
      apollo_module: 'nametag',
      enable: true
    }]
  }
}

export function overrideApolloNametagMessage(uuid: unknown, line: unknown): ApolloJsonMessage {
  return {
    '@type': 'type.googleapis.com/lunarclient.apollo.nametag.v1.OverrideNametagMessage',
    player_uuid: apolloUuid(uuid),
    adventure_json_lines: [JSON.stringify(line)]
  }
}

export function resetApolloNametagMessage(uuid: unknown): ApolloJsonMessage {
  return {
    '@type': 'type.googleapis.com/lunarclient.apollo.nametag.v1.ResetNametagMessage',
    player_uuid: apolloUuid(uuid)
  }
}

export function resetAllApolloNametagsMessage(): ApolloJsonMessage {
  return {
    '@type': 'type.googleapis.com/lunarclient.apollo.nametag.v1.ResetNametagsMessage'
  }
}

export function apolloJsonPacket(message: ApolloJsonMessage): { channel: string; data: Buffer } {
  return {
    channel: APOLLO_JSON_CHANNEL,
    data: Buffer.from(JSON.stringify(message), 'utf8')
  }
}
