# jake architecture

jake is a **bmo agent proxy**: the proxy through which BMO manages 하스's own remote machines. 하스
installs it on one of his machines — a Windows box or a Linux/WSL box — and 비모 drives it from
main-host. This document is the canonical statement of how the pieces fit; the code answers to it.

## The problem it solves

- The network runs one way. 비모's side cannot reach into 하스's remote machine, so nothing on
  main-host can open a connection inward.
- Therefore the agent dials **outward**. It opens one connection to the hub and holds it, and every
  command, every result, and every file transfer travels over that one connection, in both
  directions. This is why the connection feels like an SSH session even though 비모 never dialed in.

## The programs

- **hub** — runs permanently on main-host as a systemd user service. It accepts the single agent's
  outbound connection, and it exposes a loopback control API that the console and 비모 drive it
  through. It is reachable from 하스's network through a `*.ahas.io` name fronted by NPM. It holds no
  capability itself; it relays.
- **agent** — runs on one of 하스's machines from a single executable. It dials the hub,
  authenticates, and then serves what the hub asks of it: shell commands, with live-streamed output,
  and file transfers over the same connection. It listens for nothing and only dials. On a Windows
  host the same executable also runs as the **guard**, a small supervisor that carries no capability
  and only keeps the agent alive; the command line chooses which of the two a process is. On a Linux
  host the agent needs no guard, because the platform's own service manager keeps it running. The
  staying-alive scheme below covers both.

## What crosses the tunnel

- **Shells.** The agent runs commands through the shells the host offers. On a Windows host these are
  PowerShell and WSL; on a Linux or WSL host it is a Linux shell. Anything a person at that machine
  could do from a shell prompt — take a screenshot, make an HTTP request from inside 하스's LAN,
  launch a program — is done by sending that command, so it needs no capability of its own in the
  agent. The command recipes for the common cases are kept in docs/recipes.md.
- **Files.** The agent moves files over the tunnel's own frames, in both directions — an upload the
  hub writes onto the machine, and a download the hub reads back from it. This is a first-class
  capability, not a shell trick, because the tunnel is a WebSocket and no outside path such as scp
  can reach a machine that only dials outward. A transfer is chunked so that a large file is never
  truncated, each chunk small enough to cross without hitting a payload cap, and it closes with a
  check of the whole content against a declared byte count and checksum, so a torn or partial
  transfer is caught rather than accepted. The frames are stated in docs/protocol.md; the transfer
  mechanism is described under "Moving files" below.
- The build still bundles nothing beside the executable and the install layout — the agent needs no
  screen-capture helper, no HTTP client, and no browser driver, because those are shell commands, and
  no external file tool, because file transfer rides the tunnel. A new need that a shell command
  covers is met by that command, not by a new build on 하스's machine.

## The agent's connection

- The agent dials outward and holds one socket open, and it redials without end. A hub that is down
  for a day must not leave the agent silent forever, so a lost connection is retried on an
  exponential backoff that is jittered — to keep repeated retries from falling into lockstep — and
  capped, so an outage of any length settles at a steady redial rate rather than drifting toward
  hours between tries. A connection that was welcomed and then stayed up long enough to be trusted
  resets the backoff, so an occasional flap does not push the delay toward its ceiling while a
  genuine outage still does.
- Liveness is judged by traffic, not by the socket alone. The agent answers the hub's ping promptly
  and sends its own on an interval, and it treats a stretch of silence from the hub — past a window
  of several intervals — as a dead connection worth redialing, even when the socket has not errored.
- Nothing in flight survives the socket it streamed over. On any loss every running command is
  stopped; a command is never resumed across a broken socket, and output that a run produces after
  the loss is dropped rather than sent.
- The hello list names the shells the agent can run, and the shell runner contributes those names
  itself. The core owns the wire — framing, sequence numbers, sending — and the runner owns only
  spawning, streaming, and stopping.
- The agent keeps a bounded rolling log on its own machine, in a per-user location that needs no
  elevation. Because a failure on 하스's box may be exactly that the hub is unreachable, the record
  of what the agent did has to be readable there without the hub; the log rotates by size and keeps
  a fixed number of old files so it cannot fill the disk.

## Configuration and secrets

- Each side reads a single environment file at startup, and nothing is compiled into a binary. The
  agent's file sits beside its executable; the hub's sits under its data directory, outside the git
  tree. The repository carries only the example files.
- The connection secret and the control token are entered at install time and live only in those
  files. A loader that cannot find a required key reports the key by name and stops — it never runs
  a process against a guessed credential.
- One shared secret authenticates the agent to the hub, presented as a Bearer credential at the
  connection's upgrade. A separate token guards the hub's loopback control API. The two are distinct
  so that the console's reach and the agent's reach are not the same key.

## Staying alive

The agent must come back on its own from a crash and a reboot, so that BMO's link to 하스's machine
survives without anyone tending it. How it comes back depends on the host, because the two platforms
give very different footing for keeping a per-user process running.

### On a Linux host

- A Linux host has a per-user service manager, so the agent is kept alive the plain way: it runs as a
  `systemd --user` unit that restarts it on failure and starts it at boot. Lingering is enabled for
  the user so the unit runs whether or not that user is logged in, which is the boot-time recovery a
  Windows host cannot get without an administrator account. This is the same shape the hub already
  uses on main-host, so the Linux agent needs no guard, no heartbeat pair, and no anchor rewriting —
  the service manager is the supervisor.
- A WSL host is Linux only when systemd is running as its init. Where it is not, `systemctl --user`
  cannot register anything, and the install **fails loudly** with that reason rather than writing a
  unit that would never run — enabling systemd in WSL is a host step 하스 takes, not something the
  agent can arrange for itself from inside the session it would run in.

### On a Windows host

- Windows has no per-user, no-elevation, boot-capable service manager, so the same reliability is
  built by hand from a pair of processes that keep each other alive. 하스's Windows environment resets
  from time to time, and a reset can wipe a scheduled-task entry; the pair is what lets the agent
  return from a crash, a reboot, and the deletion of any one autostart registration.
- The pair is two processes of one executable. Run with no argument it is the **agent** — the tunnel
  and the shell; run with the guard-mode flag it is the **guard** — a small supervisor that
  carries none. One deliverable, two run modes: the guard exists so that a failure of the agent
  process is caught and repaired by something that is still running, and the agent returns the favour.
  They are distinct processes with distinct anchors and distinct scheduled tasks, so either can be
  relaunched on its own, and each watches the other.
- Each process watches the other by a heartbeat, not by watching for an exit. On every tick a
  process rewrites the file that records its own liveness and reads the file its peer keeps; a peer
  whose timestamp is older than the staleness threshold — or whose file is missing — reads as dead,
  so a hung peer that never exited is brought back just as a crashed one is. A process finding its
  peer stale relaunches it; every process, on every tick, rewrites all the autostart anchors, so the
  wipe of any single anchor is repaired within one tick as long as either process is alive.
- The relaunch runs the peer's scheduled task rather than spawning the peer directly. The Task
  Scheduler service starts the peer on the caller's behalf, so the relaunched peer is not the
  caller's child and shares no teardown boundary with it — the independence the pair depends on. A
  redundant relaunch is harmless because of the single-instance guard below.
- The tick is one minute and the staleness threshold is three minutes — three ticks — both
  configuration rather than constants. Three ticks means a peer is declared dead only after it has
  missed three consecutive heartbeat writes, so one slow or paused tick does not cause a false
  relaunch, while a real death or hang is caught within about three minutes.
- The three anchors are all per-user and need no elevation: a logon-triggered scheduled task with no
  stored credentials, a per-user run entry in the registry, and a shortcut in the Startup folder.
  Both run modes are anchored all three ways — the agent's anchors launch the executable with no
  argument, the guard's launch it with the guard-mode flag — so either can return on its own at
  logon. The consequence of staying per-user is stated plainly: after a kill that ends both processes
  and wipes the anchors, recovery is bound to this user's **next interactive logon**, not to the next
  boot. On a machine without auto-logon those are different events, and the gap between them is
  unbounded until someone logs in. Boot-time recovery, or a task that runs whether the user is logged
  on or not, would need an administrator account the install may not have, so neither is used.
- Because all three anchors for a run mode fire at the same logon, a single logon would otherwise
  start three copies of it. A single-instance guard prevents that: each run mode takes an exclusive
  lock on startup, and only the copy that takes it runs while the rest exit. The lock is a file created
  atomically — the OS lets exactly one exclusive create win, so even near-simultaneous copies cannot
  both take it — and it holds the holder's process id, so a lock left behind by a crashed process is
  reclaimed once that id is seen to be gone, rather than blocking the binary forever.

## Leaving

- A leave is a clean, complete uninstall of 하스's own tool, sent from the hub instead of run by hand
  on the machine. It has to be complete for the same reason the staying-alive scheme is thorough: a
  removal that undid only part of the install would be repaired by the part it left running, so
  leaving is a single ordered act that stops every part and removes every file it placed.
- The leave signal reaches the agent over the tunnel — it is the one instruction the hub carries that
  is not a shell command. Only the agent holds the tunnel, so a leave is possible only while the agent
  is attached.
- On a Linux host, leaving is what the service manager already makes simple: the agent stops and
  disables its own `systemd --user` unit so nothing restarts it, removes the unit file, deletes its
  data directory and log, and exits. Because the executable was placed as an ordinary per-user file,
  it can be removed the same way.
- On a Windows host, the order is what makes the removal hold, since the guard would otherwise revive
  the agent. When only the guard is up, it revives the agent first and the leave waits for that. The
  agent then stops its own watchdog, so it stops rewriting anchors and reviving the guard; it stops
  the guard by the process id the guard records in its single-instance lock, ending the guard's whole
  tree, so the guard stops rewriting anchors and reviving the agent. With neither process restoring
  anything, it removes all three anchors for both run modes, hands the file deletion to a separate,
  self-owned cleanup, and exits.
- The Windows cleanup cannot be the agent itself: a running executable cannot delete its own file. It
  is therefore a one-shot scheduled task, run the same way the watchdog relaunches a peer — Task
  Scheduler owns the process, so it outlives the agent's exit. The cleanup waits for the executable to
  become deletable, which happens once the agent has exited and released it, then deletes the
  executable, the whole install folder, and the whole data directory (log, heartbeats, locks), and
  finally deletes its own task, so the uninstall leaves nothing running and nothing registered.
- The departure is idempotent in spirit rather than transactional: each step is guarded so one failure
  does not strand the rest, because a half-removed install is worse than one that pressed on. Nothing
  needs an administrator account, matching the rest of the per-user scheme.
- Leaving is the remote counterpart of the local uninstaller. The uninstaller is run by hand on the
  machine and can keep the config for a reinstall; a leave is sent from the hub, keeps nothing, and
  does not come back. It is deliberately guarded on the console side so a slip cannot trigger it.

## Running commands

- A command runs through one of the host's shells and its output streams back as it is produced,
  chunk by chunk, never held until the command finishes. A program that prints without a trailing
  newline is forwarded as its bytes arrive rather than looking hung waiting for a full line. The
  shells a build offers depend on the host: PowerShell and WSL on a Windows host, a Linux shell on a
  Linux or WSL host. The agent advertises only the shells its own platform can run, so the hub never
  offers a shell the machine cannot serve.
- PowerShell is run non-interactively, without the user profile, and with the execution policy
  bypassed, so an unattended command neither prompts nor is refused for policy. Its console output is
  forced to UTF-8, so a non-ASCII character crosses the tunnel as itself rather than as mojibake in
  the machine's OEM code page. WSL is entered through its launcher with an optional distribution and
  working directory, and the command runs in a login shell so its environment matches what a person
  gets at an interactive prompt. The Linux shell runs the command in a login shell in the same way,
  so its environment likewise matches an interactive prompt.
- Stopping a command ends its whole process tree, not only the shell that was launched: a shell that
  started something else must not leave that behind. How the tree is ended is platform-aware — on
  Windows the Task Scheduler's own tree-terminating kill, on Linux a signal to the command's process
  group, escalating from a polite to a forceful signal if the group does not exit — because the way
  to reach a whole tree differs per platform and a Windows-only kill would silently fail to stop
  anything on Linux. A caller's cancel is reported as a cancel, distinct from a natural exit.
- Two caps guard the hub against a runaway command: a ceiling on total output and a wall-clock ceiling
  on how long it may run. Reaching either stops the command and states the reason as a final line of
  the command's output, so a recursive listing of a whole drive cannot flood the hub. A cap or a
  timeout stop is jake's own doing, so it is not reported as a caller's cancel. Both ceilings are
  configuration, not constants.

## Moving files

- A file crosses the tunnel over the protocol's own frames, because the connection only dials
  outward and no scp-style path can reach the machine. Both directions exist: an **upload** the hub
  writes onto the machine, and a **download** the hub reads back from it.
- A transfer opens with a frame that names the transfer, its direction, and the path on the machine,
  and that carries — from the side about to send the bytes — the total byte length and a checksum of
  the whole content. The content then streams as a run of chunk frames, each carrying the transfer's
  id, a sequence number that orders it, and its bytes. The transfer closes with a frame stating the
  total bytes sent and the checksum.
- No chunk is large enough to be refused. Each side reads its own payload cap from configuration and
  the two are not negotiated on the wire, so a frame that exceeds the receiver's cap is dropped
  silently, the connection staying open — which would leave a gap no sequence number reveals.
  A transfer therefore fixes its chunk size well below the smaller cap a deployment would set, so a
  chunk can never trip a cap in the first place.
- Completion is verified, never assumed. The receiver assembles the chunks in sequence order and, on
  the closing frame, checks the bytes it actually assembled against the declared total and checksum
  before it accepts the file. An upload is streamed to a temporary path and moved into place in one
  atomic step only once that check passes, so a reader on the machine never sees a half-written file.
  A mismatch — a dropped chunk, a wrong length, a bad checksum — or a file-system failure such as a
  missing file, a permission denial, or a full disk, is reported as an error frame carrying the
  transfer's id, so a partial transfer is never mistaken for a whole one. Pseudocode of the receive
  side:

  ```
  on begin(id, direction, path, total, checksum):
      open a temp sink for id, remember total and checksum
  on chunk(id, seq, bytes):
      append bytes to id's sink in seq order; abort with an error frame if a cap or write fails
  on end(id, total, checksum):
      if assembled bytes != total or hash(assembled) != checksum: send error(id); discard temp
      else: atomically move temp into place; acknowledge id
  ```

## The console

- 하스 must be able to see, from a console, whether the agent is attached and whether commands are
  moving. A command-line tool against the hub's loopback control API is the primary surface — it is
  also the handle a headless session on main-host uses to drive the agent, so no change inside 비모
  is required. A thin read-only web page over the same API shows connection state and recent traffic.
- Both surfaces read the control token from the hub's configuration, not from an argument. The CLI
  runs one command and returns the agent's own exit code for an `exec`, so a caller branches on it as
  it would on a local shell; the page only reads and offers no control the CLI does not. The CLI also
  moves a whole file across the tunnel in either direction — an upload of a local file onto the
  machine, a download of a file on the machine back to main-host — each verified against its checksum
  before it is reported done, and a download written to its local path only once that check passes. It
  also carries the leave command that uninstalls the agent remotely; because it is irreversible, the CLI refuses it
  unless the intent is stated outright, and the read-only page cannot trigger it at all.
- The page is the one route of the control API served without the token: a browser navigation cannot
  attach a bearer header, so the page comes back open and carries the token embedded in it, which its
  own read requests then present. This is safe because the control API binds to loopback alone —
  anyone able to load the page is already on the machine and could read the token from the config
  file. Every other route still demands the token.

## The build and the install

- The executable is cross-compiled from main-host for both hosts — a Windows target and a Linux
  target — so no Windows toolchain and no separate Linux machine are needed to produce them. Each is
  a single self-contained file with the runtime embedded, and the build version is stamped into it at
  compile time — the agent run mode announces it to the hub. The build's output is a small layout: the
  Windows executable, the Linux binary, the example config, the install scripts for both platforms,
  and the install guide. Nothing else is bundled, because the agent needs nothing beyond the shells
  already on the machine.
- The build layout is served under `ai.example.org/bmo/jake/`, so 하스 installs with a single command
  that needs nothing downloaded by hand first. On Linux/WSL it is `curl -fsSL
  https://ai.example.org/bmo/jake/install.sh | bash`; on Windows it is `powershell -c "irm
  https://ai.example.org/bmo/jake/install.ps1 | iex"`. Each install script fetches the binary for its own
  platform — the Linux binary from `ai.example.org/bmo/jake/jake`, the Windows executable from
  `ai.example.org/bmo/jake/jake.exe` — along with the example config it needs. Serving that layout at that
  path is host infrastructure BMO owns, not something jake's own checkout can arrange.
- The installer runs in 하스's own user session without elevation. It places the binary in a per-user
  location and writes the hub URL, the shared secret, and the agent name into the config file beside
  it — the credential is entered at install time and exists only in that file, never in the repository
  and never in the executable. It then registers the agent so it stays running by the means the host
  offers: on Windows all three anchors for both run modes, starting the pair; on Linux a
  `systemd --user` unit with lingering enabled, started at once, failing loudly where systemd is not
  available. It verifies by reading the agent's own local log for a record that it reached the hub,
  because the installer runs on 하스's machine and cannot reach the hub's loopback control API.
- The install is re-runnable over an existing one without duplicating its registrations: on Windows
  each anchor is overwritten in place and a running pair is stopped before its executable is replaced
  and started again after; on Linux the unit is refreshed and restarted. Hand-edited tuning keys in
  the config are preserved either way. The uninstaller reverses it — stopping the agent, removing its
  registrations, and deleting the layout — and leaves removing the config an explicit choice, so a
  reinstall keeps the hub URL and secret unless they are asked to be dropped.

## The hub on main-host

- The hub runs permanently on main-host as a systemd **user** service, restarted on failure and
  brought up at boot once lingering is enabled for the user. It does not start until its config file
  exists — the unit's condition guards that file — so a box without the secret and control token in
  place stays quiet rather than crash-looping. Only the hub has a systemd unit; the agent and the
  guard keep themselves alive on Windows by the anchors described above, since 비모 cannot reach into
  하스's box to start anything.
- The hub reads its one config file itself, from a fixed path under the data directory outside the
  git tree, the same way the agent reads the file beside its executable and the console reads this
  very file. So one path is at once what the unit's condition guards, what the hub loads at startup,
  and where the console finds the control token — the two sides of the loopback API cannot disagree
  about where it lives. The repository carries only the example; the real file, holding the shared
  secret and the control token, is never committed.
- 하스's network reaches the hub at `jake.example.org`: a Cloudflare CNAME to `home.example.org`, DNS only,
  resolved through the router's DDNS name to NPM, which forwards it to main-host on the hub's port.
  The agent dials that name over TLS and holds the connection open, so the whole tunnel is a single
  long-lived WebSocket riding the same path a browser would.
- The proxy host at NPM is written as both a database row and the nginx config that row would
  generate, and the config states the WebSocket upgrade headers and the wildcard certificate
  outright rather than leaning on a UI toggle — so the upgrade survives the proxy no matter how NPM
  would otherwise render it. The certificate is the live `ahas.io, *.ahas.io` wildcard, which already
  covers the name, so no new certificate is issued.
- The hub's listen port and bind address are configuration, not constants: the port is what NPM
  forwards to and must match on both sides, and the bind address is wide enough to accept the
  forwarded connection. The command-by-command deployment procedure — the DNS record, the config
  file, the service, the proxy host, and how to verify each — is kept in docs/deploy.md.
