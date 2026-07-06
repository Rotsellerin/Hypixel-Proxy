# Hypixel Proxy

Local Minecraft proxy for Hypixel with routing selection, local-only player nicknames, and small QoL helpers.

## Quick Start For A Friend

1. Install Node.js LTS from https://nodejs.org/
2. Extract this folder somewhere normal, for example Desktop or Downloads.
3. Double-click `app\Hypixel Proxy.exe`.
4. Click `Start` in the app. Open Minecraft and join:

```text
localhost
```

On first login, the proxy may show a Microsoft link and code. Sign in with the Microsoft account that owns the Minecraft account.

If the `.exe` has not been built yet, double-click `Hypixel Proxy.vbs` as a fallback. If you want the old terminal view for debugging, double-click `start.bat` instead.

## Start

Install Node.js first. Then run one of these from this folder:

```bash
npm install
npm run build
npm start
```

On Windows you can double-click:

```text
app\Hypixel Proxy.exe
```

The app has `Start`, `Stop`, `Restart`, route selection, QoL controls, logs, and Microsoft auth copy buttons.

You can rebuild the app with:

```powershell
.\build-app.ps1
```

You can also double-click `Hypixel Proxy.vbs` as a fallback, double-click `start.bat` for the terminal launcher, or run:

```powershell
.\start.ps1
```

The local control API runs in the background for the app. You normally do not need to open it in a browser.

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

## Routing

Minecraft always connects to the local proxy first:

```text
Minecraft client -> local proxy
```

The app chooses the next hop for new sessions:

```text
Direct:     local proxy -> mc.hypixel.net:25565
StopTheLag: local proxy -> chi1.qtx.stopthelag.lol:25566 -> Hypixel
```

Route changes are saved in `state/app-config.json`. If you change route while already connected, the active session keeps its current upstream and the next Minecraft connection uses the new route.

## Microsoft Auth

When Microsoft sign-in is needed, the app shows the Microsoft link and code in the log panel. The proxy also prints it in the terminal if you use the terminal launcher. Tokens are cached locally under `state/auth-cache`.

Each person should sign in with their own account. Do not share `state/auth-cache`.

## Nicknames

These commands are local. They are not sent to Hypixel.

```text
/nickname <player> "custom nickname"
/nickname <player> clear
/nicknames
```

Nicknames are saved in `state/nicknames.json`.

## Split Reminder

The local split reminder watches incoming chat for your respawn window and teammate death messages. It only rewrites the center title: if a teammate dies while you are waiting to respawn, the next `RESPAWNED!` title is shown locally as `SPLIT!`.

This does not send anything extra to Hypixel. It is a local rewrite only. The app can turn it on/off and adjust the respawn window. Advanced pattern settings are saved in `state/app-config.json`.

## Config

Copy `.env.example` to `.env` to override defaults:

```text
MC_VERSION=1.8.8
LISTEN_HOST=127.0.0.1
LISTEN_PORT=25565
HYPIXEL_HOST=mc.hypixel.net
HYPIXEL_PORT=25565
STOPTHELAG_HOST=chi1.qtx.stopthelag.lol
STOPTHELAG_PORT=25566
DASHBOARD_HOST=127.0.0.1
DASHBOARD_PORT=25765
STATE_DIR=state
```
