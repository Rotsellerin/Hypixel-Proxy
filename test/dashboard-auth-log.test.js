const assert = require('assert')
const { once } = require('events')
const { startDashboard } = require('../dist/dashboard')

async function main () {
  let shutdownCalled = false
  const server = startDashboard({
    host: '127.0.0.1',
    port: 0,
    getStatus: () => ({
      version: '1.0.0',
      localAddress: 'localhost',
      dashboardAddress: 'http://127.0.0.1:0',
      activeSessions: 0,
      route: { id: 'direct', name: 'Direct', host: 'mc.hypixel.net', port: 25565 },
      routes: [],
      splitReminder: { enabled: true },
      logs: [{
        time: '13:00:00',
        label: 'Microsoft',
        message: 'Sign in as Steve using https://microsoft.com/link and code ABC123.',
        kind: 'microsoft_auth',
        url: 'https://microsoft.com/link',
        code: 'ABC123',
        player: 'Steve'
      }]
    }),
    getSplitSoundStatus: () => ({ eventId: 7 }),
    getBlockHitSoundStatus: () => ({ eventId: 11 }),
    setRoute: () => ({}),
    setSplitReminderEnabled: () => ({}),
    setBlockHitSoundEnabled: enabled => ({ enabled }),
    setBlockHitSoundVolume: volume => ({ volume }),
    testBlockHitSound: () => ({ ok: true, playedSessions: 1 }),
    shutdown: () => {
      shutdownCalled = true
      return { ok: true }
    }
  })

  try {
    await once(server, 'listening')
    const address = server.address()
    const baseUrl = `http://127.0.0.1:${address.port}`

    const root = await fetch(baseUrl).then(res => res.text())
    assert.match(root, /control API/)
    assert.doesNotMatch(root, /renderAuthLog/)

    const status = await fetch(`${baseUrl}/api/status`).then(res => res.json())
    assert.equal(status.logs[0].kind, 'microsoft_auth')
    assert.equal(status.logs[0].url, 'https://microsoft.com/link')
    assert.equal(status.logs[0].code, 'ABC123')

    const splitSound = await fetch(`${baseUrl}/api/split-sound`).then(res => res.json())
    assert.equal(splitSound.eventId, 7)

    const blockHitEvents = await fetch(`${baseUrl}/api/blockhit-sound/events`).then(res => res.json())
    assert.equal(blockHitEvents.eventId, 11)

    const blockHitSetting = await fetch(`${baseUrl}/api/blockhit-sound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false })
    }).then(res => res.json())
    assert.equal(blockHitSetting.enabled, false)

    const blockHitVolume = await fetch(`${baseUrl}/api/blockhit-sound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ volume: 35 })
    }).then(res => res.json())
    assert.equal(blockHitVolume.volume, 35)

    const blockHitTest = await fetch(`${baseUrl}/api/blockhit-sound/test`, { method: 'POST' }).then(res => res.json())
    assert.equal(blockHitTest.playedSessions, 1)

    const shutdown = await fetch(`${baseUrl}/api/shutdown`, { method: 'POST' }).then(res => res.json())
    assert.equal(shutdown.ok, true)
    assert.equal(shutdownCalled, true)
  } finally {
    server.close()
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
