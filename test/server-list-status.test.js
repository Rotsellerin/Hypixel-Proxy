const assert = require('assert')
const { createRouteCatalog } = require('../dist/appConfig')
const { __test } = require('../dist/index')

const routes = createRouteCatalog()
const direct = routes.find(route => route.id === 'direct')
const stopTheLag = routes.find(route => route.id === 'stopthelag')

const directStatus = __test.serverListStatusResponse(direct, null, 47)
assert.deepEqual(directStatus.version, { name: '1.8.8', protocol: 47 })
assert.equal(directStatus.description.extra[0].text, '                           ')
assert.equal(directStatus.description.extra[1].text, 'Hypixel Proxy')
assert.equal(directStatus.description.extra[3].text, '                 ')
assert.equal(directStatus.description.extra[4].text, 'Direct')
assert.equal(directStatus.description.extra[6].text, '  Ping: ')
assert.equal(directStatus.description.extra[7].text, 'checking...')
assert.equal(directStatus.players.max, 1)
assert.equal(directStatus.players.online, 0)
assert.match(directStatus.players.sample[1].name, /Proxy -> Hypixel ping: checking/)
assert.match(directStatus.players.sample[2].name, /Local: /)
assert.match(directStatus.favicon, /^data:image\/png;base64,/)

const upstream = {
  version: { name: 'Hypixel', protocol: 47 },
  players: { online: 123, max: 456 },
  latency: 143
}
const stopTheLagStatus = __test.serverListStatusResponse(stopTheLag, upstream, 47)
assert.deepEqual(stopTheLagStatus.version, upstream.version)
assert.equal(stopTheLagStatus.description.extra[3].text, '            ')
assert.equal(stopTheLagStatus.description.extra[4].text, 'StopTheLag')
assert.equal(stopTheLagStatus.description.extra[7].text, '143ms')
assert.equal(stopTheLagStatus.description.extra[7].color, 'yellow')
assert.equal(stopTheLagStatus.players.online, 0)
