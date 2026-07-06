export type MsaCode = {
  user_code?: string
  verification_uri?: string
  expires_in?: number
}

export function microsoftAuthPrompt(player: string, data: MsaCode) {
  const url = data.verification_uri || 'https://microsoft.com/link'
  const code = data.user_code || 'UNKNOWN'

  return {
    url,
    code,
    terminalInstruction: `Please go to ${url} and enter the code ${code}.`,
    terminalAccount: `Then sign into the Microsoft account you use for ${player}.`,
    chatIntro: { text: `Microsoft > Attempting to authenticate with the Microsoft account for ${player}...`, color: 'aqua' },
    chatLink: {
      text: '',
      extra: [
        { text: 'Microsoft > ', color: 'aqua' },
        { text: 'Go to ', color: 'gray' },
        {
          text: url,
          color: 'aqua',
          underlined: true,
          clickEvent: { action: 'open_url', value: url },
          hoverEvent: { action: 'show_text', value: 'Open Microsoft device login' }
        },
        { text: ' and enter code ', color: 'gray' },
        { text: code, color: 'yellow', bold: true }
      ]
    },
    chatAccount: { text: `Microsoft > Then sign into the Microsoft account you use for ${player}.`, color: 'aqua' }
  }
}
