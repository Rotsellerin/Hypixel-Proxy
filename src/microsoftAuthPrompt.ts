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
    terminalAccount: `Then sign into the Microsoft account you use for ${player}.`
  }
}
