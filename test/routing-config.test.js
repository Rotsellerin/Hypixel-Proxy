const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  createRouteCatalog,
  loadAppConfig,
  normalizeAppConfig,
  routeById,
  saveAppConfig
} = require('../dist/appConfig')

const routes = createRouteCatalog()
assert.equal(routeById('direct', routes).host, 'mc.hypixel.net')
assert.equal(routeById('direct', routes).port, 25565)
assert.equal(routeById('stopthelag', routes).host, 'chi1.qtx.stopthelag.lol')
assert.equal(routeById('stopthelag', routes).port, 25566)
assert.equal(routeById('unknown', routes).id, 'direct')

const normalized = normalizeAppConfig({
  routeId: 'stopthelag',
  splitReminder: {
    enabled: false,
    respawnedText: '',
    replacementText: 'SPLIT NOW'
  }
})
assert.equal(normalized.routeId, 'stopthelag')
assert.equal(normalized.splitReminder.enabled, false)
assert.equal(normalized.splitReminder.respawnedText, 'RESPAWNED')
assert.equal(normalized.splitReminder.replacementText, 'SPLIT NOW')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hypixel-proxy-'))
try {
  assert.equal(loadAppConfig(tmp).routeId, 'direct')

  saveAppConfig(tmp, {
    routeId: 'stopthelag',
    splitReminder: {
      ...normalized.splitReminder,
      enabled: true
    }
  })

  const reloaded = loadAppConfig(tmp)
  assert.equal(reloaded.routeId, 'stopthelag')
  assert.equal(reloaded.splitReminder.enabled, true)
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
