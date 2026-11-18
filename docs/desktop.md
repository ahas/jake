# The desktop app

The desktop app is BMO's web console in a window of its own that carries a jake agent inside it. It is
the second way a person's machine is joined to the hub, beside the one-line install (docs/install.md),
which stays as it is. This document is the canonical statement of the app; the `desktop` crate answers
to it.

## What it is

- **The hosted console in a window.** The main window loads the console the deployment serves, not a
  copy bundled into the app: the console is rendered on its server and relays through that server, so
  only the hosted one works. Its address is a setting, `consoleUrl` in the app's `settings.json` under
  the app's per-user config directory, and defaults to `https://ai.example.org/bmo/`.
- **A built-in agent while the app runs.** The app runs the agent crate as a library on its own
  runtime, under the person's own machine credential, so the machine is reachable through the hub for
  as long as the app is open, with the same shells, transfers and streams an installed agent offers.
- **A tray icon.** The tray opens the console again, shows the agent's state, opens the settings,
  turns starting at sign-in on and off, and quits. Quitting stops the agent.
- **Settings of its own,** on a screen the tray and the window open: whether control is kept while
  the PC is locked, what closing the window does, starting at sign-in, starting in the tray, and
  keeping the PC awake (「Settings」).
- **One copy at a time.** A second launch brings the running copy's window forward and exits, since two
  copies would hold one name twice.

## The crate and its workspace

- **`desktop` is a Cargo workspace of its own inside this repository,** reading the agent crate by its
  path, so the app and the installed agent run the same code with no dependency across repositories.
- **It stands outside the root workspace for two present reasons.** The root workspace is what the
  hub's deployment builds and lints in full, every package of it, and that build must need no webview
  system libraries and pay no webview build time. And the root's release build aborts on a panic,
  while the app is built with unwinding so that a panic in the agent ends only the agent's task.
- **Its checks are run apart:** `bun run check:desktop` lints, formats and tests it, on a machine that
  has the webview libraries (on Linux, WebKitGTK 4.1 and its development files). `bun run check`
  stays the whole check of the root workspace and the console.

## The agent as a library

- **The agent crate is a library as well as the `jake` executable.** The executable reads `agent.env`
  and runs as it always has; the library entry is what the app calls.
- **The entry takes its configuration in memory:** the hub URL, the agent's name and its credential,
  with every other setting at the default an empty `agent.env` would give. It reads no file and no
  environment variable.
- **It runs on the caller's runtime** and ends when the caller's stop signal resolves, when the hub
  sends a leave, or, where the caller asked for it, when the hub hands the agent's name to another
  connection. Its answer says which of the three ended it.
- **It reports its link as it goes:** connecting, attached, refused by the hub, or unable to reach it,
  through a watch the caller reads.
- **It says what it would launch for a command without launching it:** for an exec frame and a
  platform, the program, its arguments, the directory and the environment overlay. The crate's
  `exec-invocation` example prints that for a frame on standard input, which is how the hub's
  contract tests hold a Windows launch, WSL's among them, on a Linux machine.
- **A leave asks nothing of the machine.** The library does not uninstall anything; the executable
  runs its departure after the entry answers that the hub sent a leave, and the app forgets its
  credential instead (「Keeping the agent running」).

## Pairing

The app never asks for the shared secret and never shows a credential. It obtains the person's own
machine credential, `<name>.<mac>` (docs/architecture.md, 「Configuration and secrets」), through the
console's device pairing, which the account service mints for the machine the signed-in person's
account is bound to.

```mermaid
flowchart TD
  A[App starts with no credential] --> B[Rust side asks the console for a pairing]
  B --> C[Window opens the approval page]
  C --> D[Person signs in and approves]
  B --> E[Rust side polls the pairing]
  D --> E
  E -->|approved| F[Credential into the OS store]
  F --> G[Agent starts]
  E -->|expired or refused| H[Local page offers to pair again]
```

- **The contract with the console.** A pairing is asked for with an unauthenticated
  `POST /api/desktop/pairings` under the console's address, answered with the pairing's id, a short
  code, the approval page's address and how many seconds to wait between polls. The app polls
  `GET /api/desktop/pairings/<pairing>`: 202 while waiting, 200 with the machine's name, its credential
  and the hub's URL once approved, which is answered once only, and 410 once the pairing expired or was
  refused. A pairing expires after ten minutes.
- **The page never touches the credential.** The Rust side asks for the pairing and polls it over its
  own HTTPS client; the window only shows the approval page, so the credential never passes through
  the page's JavaScript.
- **The code is shown on both sides.** The app shows the pairing's code in its window title and on its
  local page, and the approval page shows the same code, so the person can see they are approving this
  app.
- **The answer is checked before it is kept:** the credential must name the machine the answer names,
  and the hub's URL must be a WebSocket address. An approval page outside the console's origin is
  refused.
- **A pairing that fails is offered again,** by a button on the local page; the app never asks the
  console for pairings in a loop of its own.

## The credential's storage

- **The credential is kept in the operating system's credential store**, through the `keyring` crate:
  Windows Credential Manager, the Secret Service on Linux, the Keychain on macOS. One entry, under the
  service `io.ahas.jake.desktop`, holds the machine's name, its credential and the hub's URL.
- **Where no store stands, nothing is kept.** On a Linux machine with no Secret Service, a headless one
  or a WSL distribution without a desktop session, the app says the credential cannot be kept, starts
  no pairing and runs no agent. It never writes the credential to a file.
- **A credential the hub refuses is kept.** The agent keeps redialling and the state reads as refused,
  since a refusal from a hub that has not yet learnt the key is cured on the hub's side.

## Keeping the agent running

- **The agent runs as one task the app supervises.** The app is built with unwinding, so a panic ends
  that task alone and the app stays up.
- **A task that panics is started again after a pause** that doubles from one second to a ceiling of
  five minutes, and returns to one second once a run has lasted ten minutes. The state reads as
  restarting while it waits.
- **A leave from the hub ends the built-in agent for good:** the app deletes the stored credential,
  stops the agent and offers pairing again, since the hub has removed this machine.
- **The state is shown** in the tray icon's tooltip and on the local page: starting, pairing, pairing
  failed, no credential store, connecting, attached, refused by the hub, hub unreachable, restarting
  after a fault, paused while the PC is locked, held off for an installed agent, given up to another
  agent of its name, and removed by the hub.

## One agent per name

The hub keeps one connection per name, and a newer hello replaces the older (docs/architecture.md,
「Many agents, one hub」). Two agents of one name that both redialled would replace each other without
end, so the built-in agent gives way, twice over.

- **It does not start beside an installed agent of its name.** Before the agent starts, the app looks
  for an installed jake agent running on the machine: on Windows by the agent's single-instance lock in
  its data directory, held by a live process; on Linux by the main process of the `jake-agent` user
  unit. The running executable's own folder holds the `agent.env` that names it. Where that name is the
  built-in agent's, the built-in agent stays off and the app says an installed agent already serves
  this machine, offering to keep using it, with a button that looks again.
- **It yields to any agent that takes its name.** When the hub closes the built-in agent's connection
  as superseded by a new one, the built-in agent stops instead of redialling, and the app reads as held
  off for another agent of its name. An installed agent the first check cannot see, one inside a WSL
  distribution of the same machine, therefore wins after a single replacement, and the two never loop.
- **The installed agent is unchanged:** it redials when superseded, as it always has.

## Settings

The app's settings are kept in its `settings.json`, the file that holds the console's address.

| Key | Setting | Default | Offered on |
|---|---|---|---|
| `keepControlWhileLocked` | Keep control while the PC is locked | on | Windows |
| `closeToTray` | Closing the window sends it to the tray rather than quitting | on | every platform |
| `startAtSignIn` | Start the app when the person signs in | off | every platform |
| `startInTray` | Start in the tray, with no window, when started at sign-in | off | every platform |
| `keepAwake` | Keep the PC from sleeping while the built-in agent serves | off | Windows |
| `consoleUrl` | The console's address | `https://ai.example.org/bmo/` | the file alone |

### Reading and writing

- **A key the file does not hold takes its default.** A file that cannot be read whole, broken JSON or
  a value of the wrong type, leaves the app on its defaults with the reason in its log, and the
  settings screen then says the file cannot be read and changes nothing, since writing it would
  overwrite the hand edit it could not read.
- **A change is written the moment it is made,** the whole file replaced by a rename, so a reader never
  sees half of it. Every key the app does not know is written back as it was read, so a key a newer
  version wrote survives an older one.
- **Every setting takes effect at once,** with no restart: each is read again where it acts, at the next
  close of the window, the next lock of the session, the next sign-in, or at once where it holds
  something now (starting at sign-in, keeping awake).
- **The console's address is not on the screen.** Another address is another console, whose pairing
  the stored credential does not answer to, so it stays a hand edit read at start.

### Closing the window

- **On, closing the window hides it** and the agent carries on until the tray's quit.
- **Off, closing the window quits the app** as the tray's quit does: the built-in agent stops first, then
  the app exits.

### Starting at sign-in

- **The registration is Tauri's autostart plugin,** a per-user one that needs no administrator rights:
  a run entry in the registry on Windows, an autostart entry in the person's config on Linux. It fires
  at the person's sign-in, not at boot; on a machine that signs in by itself at boot the two are one
  moment.
- **The file holds the wanted state, and the registration is brought into line with it** whenever the
  setting changes and at every start of the app, so a registration a reset of the machine wiped is put
  back the next time the app runs. Where the file holds no value, the registration as it stands is
  taken as the setting and written into the file.
- **The tray's check item and the settings screen show the one value:** a change from either is written
  to the file and shown on the other at once.
- **A registration the system refuses leaves the setting as it was,** with the reason shown where the
  change was made: beside the switch on the screen, and in the log for the tray, whose item springs
  back.
- **Starting in the tray.** The registration starts the app with an argument that says it was started
  at sign-in. Started so with `startInTray` on, the app opens no window: the tray and the agent start as
  they always do, and the tray opens the window. Started by hand, the app always opens its window. A
  pairing needs the person, so one that opens shows the window however the app was started.

### The settings screen

- **A window of its own, one at a time,** opened from the tray's settings item, from the main window's
  menu, and from the local page. Opening it again brings the open one forward.
- **The main window carries a menu bar of one menu,** holding the settings, the status page and quit,
  since the console fills the rest of the window and the console's own pages get no command of the
  app's (「The window and what the console may call」).
- **A page of standing switches.** Each switch takes effect and is written the moment it is turned;
  there is no save button and nothing is held unsaved, so the values on the screen never differ from
  what is saved and closing the window, by its close button, Esc or Back, asks nothing.
- **A switch whose change fails** returns to the saved value, with the reason beside it.
- **Only the settings the platform offers are shown.**
- **It is a bundled page,** as the local page is, and reads and changes the settings through the app's
  commands alone.

## While the PC is locked

### What a locked Windows session allows

Locking hands the screen and input to the system's secure desktop. The person's session, its
processes and its network stay as they were.

- **What goes on:** the app and its built-in agent keep running and the agent stays attached. Commands
  run as the person, with their files and network, and may start programs; transfers, byte streams and
  streams back carry on.
- **What stops:** everything that needs the screen or input. A process of the person's cannot read the
  secure desktop, so a screenshot taken by a command fails; keys and pointer movements a command
  injects reach nothing; a window a command opens stands behind the lock, unseen.
- **What no process of the person's can do:** see or drive the lock screen, or unlock the session.
  The lock screen and the secure attention sequence belong to the system.
- **The remote desktop.** BMO's remote desktop reaches only the machine its own service runs on,
  through that machine's RDP server, and does not reach a machine through jake, locked or not. A
  remote desktop that shows and drives a locked Windows session needs either a helper running as a
  system service, which captures the secure desktop and injects input from the system account, or
  Windows's own Remote Desktop host, whose logon takes the session over. Both need administrator
  rights to install, which this per-user app does not have, and the app offers neither.
- **Sleep.** Locking does not sleep the PC, but a locked PC left alone is idle, and the power plan
  sleeps it after its idle time; a sleeping PC drops the connection until it wakes. `keepAwake`
  answers that.

### Keeping control while locked

- **On, nothing changes when the session locks:** the agent stays attached and serves all that a locked
  session allows.
- **Off, the moment the session locks the app stops the built-in agent,** with the stop signal its quit
  uses, so the connection closes and everything in flight ends as it does on a lost connection: running
  commands' process trees are ended, transfers fail, streams and streams back close. The hub lists the
  machine as not attached, not as departed, and the state reads as paused while the PC is locked.
- **On unlock the agent starts again at once.** A pause is not a fault, so it leaves the restart pause
  after a panic as it was.
- **Stopping rather than refusing.** Staying attached and refusing each request would need the agent
  library, shared with the installed agent, to carry a lock gate and a refusal the hub and the console
  surface, and would leave a stream already open live; stopping ends every kind of control at once, by
  the path a lost connection already takes.
- **How the lock is read.** The app registers for its own session's change notifications, taking a lock
  and an unlock as they come, and reads at start whether the session is locked, so an app started
  behind a lock starts paused. Switching to another person's account locks the session and counts as a
  lock.
- **A change takes effect at the next lock.** A pairing under way when the session locks goes on, and
  the agent it ends in starts once the session is unlocked.
- **It governs the built-in agent alone.** An installed agent is not the app's and serves while the
  session is locked; where one serves the machine, the built-in agent is held off and the setting has
  nothing to govern.
- **On Linux the app reads no lock,** so the setting is not offered and the agent serves whether the
  session is locked or not.

### Keeping the PC awake

- **On, while the built-in agent serves,** the app asks Windows to keep the system from sleeping for
  idleness, a request any per-user process may make. The display still turns off and the session
  still locks as the power plan says; a sleep the person chooses, a closed lid and the power button
  still sleep it.
- **The request is released** while the agent is paused or held off, when the setting is turned off,
  and when the app quits.
- **Off, the power plan alone decides,** as it does for any program.

## The window and what the console may call

- **Navigation stays on the console's origin.** The main window goes only to the console's origin and
  to the app's own bundled page; a link to anywhere else opens in the person's default browser.
- **The bundled page** says when the console cannot be reached, shows the agent's state and the
  pairing code, and offers to try the console again, pair again, look again for an installed agent or
  a credential store, or open the settings.
- **The console's origin gets no Tauri command.** Pairing needs no hand-off from the page, because the
  Rust side polls for the approval itself, so no capability lists a remote origin. The bundled pages
  alone may call the app's commands, each named in their capability: read the status, try the console
  again, retry (pair again, or look again), open the settings, and read and change a setting.
- **The console is checked before it is shown:** the app asks the console's address over HTTPS first,
  and shows the bundled page with the reason when it does not answer.

## Distribution and updates

- **Windows first:** an NSIS installer that installs for the current user alone and needs no
  administrator rights. It is unsigned until an Authenticode certificate exists, which is the owner's
  decision, so Windows SmartScreen warns on first run until then.
- **Linux second:** an AppImage and a deb package.
- **Updates go through Tauri's updater plugin with its signature check.** The app checks the feed at
  start and every six hours, and installs an update only once its signature verifies against the
  public key built into the app.
- **The update key is the owner's.** It is made once with `cargo tauri signer generate`, which writes a
  private key and asks for its password; the private key and its password are kept outside every
  repository, in the deployment's secret store (the data root's env folder), a file each, readable by
  their user alone, and are handed to a release build through the `TAURI_SIGNING_PRIVATE_KEY` and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` environment variables alone. Neither is ever committed. The
  public key is written into the updater's `pubkey` in the app's Tauri configuration.
- **The public key is written in, and the bundle makes updater artifacts,** which a release build signs
  with the private key; a release build without the two variables fails rather than ship an unsigned
  update. The app checks the feed and installs an update in Windows's passive mode, showing its progress
  and asking nothing. An app built from a configuration with no updater entry checks for none.
- **The feed is served beside the agent's builds,** at `https://ai.example.org/bmo/jake/desktop/latest.json`,
  with the installers and their signatures it names (「Releases」).
- **A build** runs `cargo tauri build` inside the `desktop` folder. The NSIS installer is built on
  main-host as well as on a Windows machine: cross-compiled for `x86_64-pc-windows-gnu` with
  `cargo-zigbuild` as the CLI's runner and `--bundles nsis`, which needs `nsis` and the mingw-w64
  binutils and C compiler for the app's Windows resources. The AppImage and the deb are built on a
  Linux machine with WebKitGTK.

## Releases

A release is one version of the app, built for every platform at once, signed for the updater and
published where both the updater and the console read it.

### Where releases are kept

- **The release folder is the `desktop` folder of the agent's served layout:** on main-host the
  directory `/var/www/ahas-ai/bmo/jake/desktop/`, which the `ai.example.org` site serves statically as
  `https://ai.example.org/bmo/jake/desktop/`. The folder belongs to the user that runs releases, so a
  release writes it without root; serving the path is host infrastructure BMO owns.
- **Each version has a folder of its own,** named by the bare version (`0.1.0`), holding the Windows
  installer, the AppImage and the deb, each beside its updater signature, and that version's release
  read. A published version is never written again: the updater installs only a version higher than
  the running one, so a fix ships as a new version.
- **Two files at the folder's top name the current version:** `latest.json`, the updater's feed in
  the form Tauri's updater reads, and `release.json`, the read the console uses. Both are replaced
  whole, each by a rename, and only once the version's folder is complete, so neither ever names a
  file that is not yet there.
- **The feed names every installer the updater may take,** each with its signature and its address:
  the NSIS installer under `windows-x86_64-nsis` and `windows-x86_64`, the AppImage under
  `linux-x86_64-appimage` and `linux-x86_64`, and the deb under `linux-x86_64-deb`. An app installed
  from the deb looks for the deb's key first, so it is never handed an AppImage.

### The read the console uses

The console builds its download page against this contract alone.

- **It reads `https://ai.example.org/bmo/jake/desktop/release.json`,** a JSON object that always describes
  the current version. The same object is kept in that version's own folder, at
  `https://ai.example.org/bmo/jake/desktop/<version>/release.json`, and never changes there.
- **The object holds:** `version`, the bare semantic version; `date`, when it was published, as an
  RFC 3339 UTC timestamp; and `files`, one entry per installer.
- **Each entry of `files` holds:** `platform`, `windows` or `linux`; `arch`, `x86_64`; `format`,
  `nsis`, `appimage` or `deb`; `file`, the file's name; `size`, its length in bytes; `sha256`, its
  SHA-256 digest in lowercase hex; and `url`, the absolute address it downloads from.
- **The download route is each entry's `url`,** a file in the version's folder served as it is, so
  a link to it downloads the installer and a version's link never changes once published.
- **No release yet reads as not found:** until the first release is published the address answers
  404, and the console shows that the app is not yet available.
- **A field may be added and none is removed or renamed,** so a console built against this contract
  reads every later release.

### Making a release

- **A release is one command run on main-host from the repository's root, `bun run release:desktop`.**
  It runs `scripts/desktop-release.ts` under a memory cap of its own, and that builds the app for
  Windows and then for Linux, one after the other, finds the installers and their signatures, and
  publishes them.
- **The version is the one in the app's Tauri configuration,** and the address it is published under
  is the folder holding the updater's endpoint, so neither is stated twice. A version not higher than
  the one already published is refused before anything is built.
- **The update key is read from the deployment's secret store by its path:** the env folder holds
  `jake-desktop-updater.key` and `jake-desktop-updater.password`, and the release hands the key to the
  build as its path and the password through its variable, printing neither. Where either file is
  missing the release stops before building.
- **Every installer and every signature must come from this run:** a file the build did not write
  afresh stops the release, so a stale build is never published under a new version.
- **The release ends by printing** the version and, for each installer, its name, its size, its
  SHA-256 and its address.
- **The Authenticode signature is not part of it:** the installer stays unsigned for Windows until
  the owner provides a certificate (「Distribution and updates」).
