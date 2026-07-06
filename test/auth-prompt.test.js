const assert = require('assert')
const { microsoftAuthPrompt } = require('../dist/microsoftAuthPrompt')

const prompt = microsoftAuthPrompt('storabollar', {
  verification_uri: 'https://microsoft.com/link',
  user_code: 'RA7J7UBR'
})

assert.equal(prompt.url, 'https://microsoft.com/link')
assert.equal(prompt.code, 'RA7J7UBR')
assert.match(prompt.terminalInstruction, /https:\/\/microsoft\.com\/link/)
assert.match(prompt.terminalInstruction, /RA7J7UBR/)
assert.match(prompt.terminalAccount, /storabollar/)

assert.equal(prompt.chatIntro, undefined)
assert.equal(prompt.chatLink, undefined)
assert.equal(prompt.chatAccount, undefined)
assert.doesNotMatch(JSON.stringify(prompt), /device_code/)
