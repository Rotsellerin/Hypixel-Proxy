# Hypixel Proxy

A local Minecraft Java Edition proxy for Hypixel with route selection, local nicknames, Bed Wars respawn timers, and other quality-of-life features.

The proxy runs on your own Windows computer. Minecraft connects to the proxy through `localhost`, and the proxy opens the authenticated connection to Hypixel.

## Requirements

- Windows 10 or Windows 11
- [Node.js LTS](https://nodejs.org/) installed
- Minecraft Java Edition with a Microsoft account that owns the game
- An internet connection during installation and Microsoft sign-in

Minecraft 1.8.9 is recommended. The proxy currently uses the Minecraft 1.8 protocol by default.

## Installation

1. Open the repository's **Releases** page and download `Hypixel-Proxy-Windows.zip` from the latest release.
2. Extract the entire ZIP to a normal folder, such as `Desktop\Hypixel-Proxy`.
3. Install Node.js LTS if it is not already installed.
4. Open the extracted `Hypixel-Proxy` folder.
5. Double-click:

```text
app\Hypixel Proxy.exe
```

Keep the complete folder together. The Windows application starts the proxy from the files beside it and will not work correctly if only the `.exe` is copied elsewhere.

The first start may take a little longer because the required Node.js packages are installed and the proxy is built locally.

## Updating

The Windows launcher checks GitHub Releases when it opens. When a newer version is available, the **Check updates** button changes to **Update available**.

1. Click **Update available**.
2. Allow the launcher to stop the proxy if it is running.
3. Confirm the update.
4. Wait for the launcher to reopen.

The updater replaces only program files. The complete `state` directory, `.env`, Microsoft authentication cache, nicknames, history, and launcher preferences remain local and are preserved. Git and GitHub CLI are not required.

If no release has been published yet, the button simply reports that no published update is available.

## Starting the proxy

1. Open `app\Hypixel Proxy.exe`.
2. Select a route. **Direct** is the normal and recommended starting option.
3. Click **Start**.
4. Wait until the application reports that the proxy is running.

The selected route is used for new Minecraft connections. Changing route while already connected does not move the active session; disconnect and reconnect to use the new route.

## Connecting to Hypixel

1. Start Minecraft Java Edition and make sure the launcher is signed in to the intended Microsoft account.
2. Open **Multiplayer**.
3. Add a server with this address:

```text
localhost
```

4. Join the local server.
5. The proxy will authenticate and connect you to Hypixel automatically.

Do not connect to `mc.hypixel.net` when you want to use the proxy. Use `localhost`, because that is the address of the proxy running on your computer.

## Microsoft authentication

The proxy uses two authenticated Minecraft connections:

```text
Minecraft client --online-mode login--> local proxy --Microsoft login--> Hypixel
```

1. Your Minecraft client authenticates normally to the local proxy. The proxy runs in Minecraft online mode and verifies the account through the standard Minecraft session system.
2. The proxy then creates a separate upstream connection to Hypixel using Microsoft authentication.
3. If no valid cached Microsoft session exists, the application displays a Microsoft URL and a one-time device code.
4. Open the URL, enter the code, and sign in with the same Microsoft account used by Minecraft.
5. After Microsoft confirms the sign-in, reconnect to `localhost` if Minecraft disconnected while authentication was being completed.

The proxy never asks for or stores your Microsoft password. Authentication is performed using Microsoft's device-code flow. The resulting authentication tokens are cached locally in:

```text
state\auth-cache
```

Treat that directory as a secret:

- Do not upload it to GitHub.
- Do not send it to another person.
- Do not include it when sharing logs or screenshots.
- Each user should authenticate with their own Microsoft account.

The proxy checks that the Microsoft account used for the Hypixel connection matches the Minecraft username connecting locally. If the accounts do not match, the connection is rejected and the mismatched cached authentication is removed.

## Normal use after installation

For future sessions:

1. Start `app\Hypixel Proxy.exe`.
2. Click **Start**.
3. Start Minecraft.
4. Join `localhost` from the multiplayer menu.

Microsoft sign-in normally does not need to be repeated while the locally cached session can be refreshed.

Use **Stop** in the application when you want to shut down the proxy. Closing Minecraft only closes the current game connection.

## Routes

The Windows application provides these routes:

```text
Direct:       local proxy -> mc.hypixel.net:25565
StopTheLag:   local proxy -> chi1.qtx.stopthelag.lol:25566 -> Hypixel
Hypixel Fast: local proxy -> mc.hypixel.fast:25565 -> Hypixel
```

Third-party routes can occasionally be slower or unstable. If players begin lagging or moving in jumps, switch to **Direct**, disconnect from `localhost`, and reconnect.

## Local commands

These commands are handled locally by the proxy and are not sent to Hypixel:

```text
/setting
/setting <path> [on|off]
/nickname add <player> <nickname>
/nickname remove <player>
/nickname list [page]
/splitsound
/obby
/obby mode held|base|both
```

Blockhit-ljudet är aktiverat som standard och spelar `mob.irongolem.hit` när du tar skada medan du blockerar med ett svärd. Det kan växlas lokalt med:

```text
/setting blockhit [on|off]
```

The Bed Wars obsidian detector combines two complementary methods by default. The held-item detector recognizes a visible player holding obsidian and resolves the team through TAB/scoreboard data. The base detector scans received chunks for obsidian close to a known bed. Both methods share the same alert history, so a team is announced only once. `/obby` lists detections from the current live match. Toggle it with:

```text
/setting obby [on|off]
```

Choose the active method with `/obby mode held`, `/obby mode base`, or `/obby mode both`. `both` is the default. Both methods only know about data Minecraft has received, so a holder or base must enter render distance. Chunk analysis runs in the background and does not delay world packets during respawn. The detector is disabled outside live Bed Wars matches and in replays.

Settings and nicknames are stored under the local `state` directory.

## Alternative terminal start

If the Windows application does not open, double-click:

```text
Hypixel Proxy.vbs
```

For a visible debugging terminal, use:

```text
start.bat
```

Developers can start it from PowerShell with:

```powershell
npm.cmd install
npm.cmd run build
npm.cmd start
```

## Changing the local port

The default Minecraft address is `localhost:25565`. If port `25565` is already in use:

1. Copy `.env.example` to a new file named `.env`.
2. Change `LISTEN_PORT` to another available port, for example `25566`.
3. Restart the proxy.
4. Join the matching address in Minecraft:

```text
localhost:25566
```

## Troubleshooting

### The application says that Node.js or npm is missing

Install the current Node.js LTS release, close the proxy application, and open it again.

### Microsoft sign-in completed but Minecraft disconnected

This can happen during the first authentication. Wait for the application to confirm the sign-in and then join `localhost` again.

### The wrong Microsoft account is selected

Stop the proxy and remove only the contents of `state\auth-cache`, then start it and complete Microsoft sign-in with the correct account.

### Minecraft cannot connect to `localhost`

Confirm that the application says the proxy is running. Also check that Minecraft is using the same port configured by `LISTEN_PORT`.

### The connection becomes unstable through a third-party route

Select **Direct**, reconnect to `localhost`, and test again. Route changes only affect new sessions.

## Local data

Runtime configuration, nicknames, launcher preferences, and authentication caches are stored under `state`. This data belongs to the local installation and should not be committed or shared.
