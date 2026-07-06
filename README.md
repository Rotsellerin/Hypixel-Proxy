# Hypixel Proxy

Local Minecraft proxy for Hypixel with local-only player nicknames.

## Quick Start For A Friend

1. Install Node.js LTS from https://nodejs.org/
2. Extract this folder somewhere normal, for example Desktop or Downloads.
3. Double-click `start.bat`.
4. When the proxy says it is ready, open Minecraft and join:

```text
localhost
```

On first login, the proxy may show a Microsoft link and code. Sign in with the Microsoft account that owns the Minecraft account.

## Sharing Safely

Before sending this project to someone else, do not include these local files:

```text
state/
.env
node_modules/
dist/
```

`state/auth-cache` contains Microsoft sign-in tokens for the local user. A clean share zip or GitHub upload should only contain source files, start scripts, package files, tests, README, and `.env.example`.

## Start

Install Node.js first. Then run one of these from this folder:

```bash
npm install
npm run build
npm start
```

On Windows you can also double-click `start.bat`, or run:

```powershell
.\start.ps1
```

## Join

In Minecraft, add a server with this address:

```text
localhost
```

If port `25565` is already taken, copy `.env.example` to `.env`, change `LISTEN_PORT`, restart the proxy, and join with:

```text
localhost:<port>
```

For example, if `LISTEN_PORT=25566`, join `localhost:25566`.

## Microsoft Auth

When Microsoft sign-in is needed, the proxy prints the Microsoft link and code in the terminal and also sends it to Minecraft chat. Only the public device-code sign-in information is shown. Tokens are cached locally under `state/auth-cache`.

Each person should sign in with their own account. Do not share `state/auth-cache`.

## Nicknames

These commands are local. They are not sent to Hypixel.

```text
/nickname <player> "custom nickname"
/nickname <player> clear
/nicknames
```

Nicknames are saved in `state/nicknames.json`.

## Config

Copy `.env.example` to `.env` to override defaults:

```text
MC_VERSION=1.8.8
LISTEN_HOST=127.0.0.1
LISTEN_PORT=25565
HYPIXEL_HOST=mc.hypixel.net
HYPIXEL_PORT=25565
STATE_DIR=state
```
