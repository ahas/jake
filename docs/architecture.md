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

- **hub** — a Rust program, the `hub` crate in this repository, that runs permanently on main-host
  as a systemd user service. It accepts the outbound
  connection of every agent installed on 하스's machines, holds them all at once, and exposes a
  loopback control API that the console and 비모 drive them through. It is reachable from 하스's
  network through a `*.ahas.io` name fronted by NPM. It holds no capability itself; it relays. The
  hub is the back end every agent shares, not a machine of its own: each attached agent is one
  machine, and the hub is how all of them are reached. Run with one of its client verbs the same
  executable is not the hub but a client of it: `connect` joins its standard input and output to a
  byte stream through the running hub, which is what makes it usable as an SSH `ProxyCommand`;
  `exec` runs one command on a machine (「The console」); `credential` prints a control credential
  scoped to named agents (「Configuration and secrets」).
- **agent** — a Rust program, the `agent` crate in this repository, that runs on one of 하스's
  machines from a single executable. It dials the hub,
  authenticates, and then serves what the hub asks of it: shell commands, with live-streamed output,
  and file transfers over the same connection. It listens for nothing and only dials. On a Windows
  host the same executable also runs as the **guard**, a small supervisor that carries no capability
  and only keeps the agent alive; the command line chooses which of the two a process is. Run with
  the leave-notice flag it is neither: it tells the hub the agent was uninstalled, and exits. On a Linux
  host the agent needs no guard, because the platform's own service manager keeps it running. The
  staying-alive scheme below covers both. The same crate is also a library, whose entry runs the
  agent on a caller's own runtime from a configuration held in memory.
- **desktop** — the desktop app, the `desktop` crate in this repository: BMO's web console in a window
  of its own, carrying a built-in agent that runs the agent crate's library for as long as the app
  runs. It is the second way a machine is joined to the hub, beside the one-line install, and obtains
  the person's own machine credential through the console's device pairing. docs/desktop.md is its
  canonical statement.

## Many agents, one hub

- An agent is known to the hub by the name its hello carries, and the name is the whole of its
  identity. The hub holds one connection per name, as many names at once as there are machines. A
  hello under a new name displaces nobody.
- **One name, one agent instance.** Beside its name, a hello carries the instance it comes from: an id
  each install makes once and keeps, the installed agent in its data directory and the desktop app's
  built-in agent in the app's config directory, so every connection one install makes carries the same
  instance and no two installs carry the same one. A hello under a name already held:
  - from the same instance, or from an agent that names none, replaces that name's connection — the
    older socket is closed with code 4000 and the stated reason `superseded by a new connection` —
    because a redial after a half-dead TCP connection must not leave two peers streaming as the same
    machine;
  - from another instance is refused: the hub answers it with a reject whose reason is
    `name held by another agent`, closes its socket with code 4009, and leaves the connection that
    holds the name as it is. The first one attached keeps the name, so a race between two installs of
    one name never makes two, and never makes them replace each other without end. The refused agent
    dials again on its backoff and takes the name once the one holding it is gone — closed, or declared
    dead by its missed pongs.

  Both reasons are part of the contract: the desktop app's built-in agent reads either to give its
  name up rather than redial (docs/desktop.md, 「One agent per name」).
- **One machine, one agent.** A hello may also carry the machine it comes from: a fingerprint of the
  physical machine that every install on it reports alike, a WSL distribution's and the Windows host's
  among them (「The machine's fingerprint」). Two installs on one PC under two names would otherwise both
  attach, and both claim the same loopback ports. A hello whose machine an attached agent of another
  name already holds is refused: the hub answers it with a reject whose reason is
  `machine held by another agent: <the holder's name>`, closes its socket with code 4009 as for a held
  name, and leaves the holder as it is. The first one attached keeps the machine; the refused agent
  dials again on its backoff and attaches once the holder is gone. A hello under the name it already
  holds follows the instance rules above whatever machine it names, and a hello that names no machine,
  from an older agent or an uninstaller's leave notice, is not checked. The desktop app's built-in agent
  reads this reason too, and gives the machine up rather than redial.
- **An install may ask whether its machine is held** before it puts a second agent on it. A request to
  the agent address with an agent credential and the query `machine=<fingerprint>` is answered, in place
  of an upgrade, 200 with `{"heldBy": <the attached holder's name, or null>}` and, where one holds it,
  the header `X-Jake-Machine-Held-By` naming it. The agent's `--machine-check` asks it
  (docs/install.md, 「One jake per machine」).
- Everything that belongs to a connection lives and dies with it: its liveness probe, its commands,
  its transfers and its streams. An agent that drops, is declared dead, or is superseded ends only what was
  running on it; the other agents' work carries on.
- Every control request that reaches a machine — a command, an upload, a download, a stream, a
  leave — names its target agent. A request that names none goes to the one agent attached when exactly one is,
  and is refused when there are several, so a request never lands on a machine nobody chose. A
  request naming an agent that is not attached is refused rather than sent elsewhere. Cancelling a
  command needs no name, because a command's id is unique across the whole hub. A revoke always
  names its agent, attached or not, since it stands for the name rather than a connection.
- The status the control API reports lists every attached agent — its name, version, capabilities,
  the machine fingerprint its hello carried (null where none), when it connected, when it last
  answered a ping, and the commands running on it — every departed one with when it left, and every revoked name with when it was revoked; the traffic log
  tags each frame with the agent it crossed to or from.
- A departed agent is one that was uninstalled, told apart from one that is merely disconnected. An
  agent the hub sends a leave to is recorded as departed at once, and so is an agent whose
  uninstaller tells the hub it was removed by hand; either is dropped from the attached list. A
  disconnected agent is simply absent from the attached list, so a reader that expects a machine can
  tell a box that is down from one that is gone. The record is kept in a file under the hub's data
  directory, so a restart does not forget it, and a later hello under a departed name — a reinstall —
  removes the name from it. A hello under a revoked name is no return: it is answered with a leave
  and recorded as a departure again (「Configuration and secrets」). The hub writes a line to its log
  for every departure and every return.

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
- **Byte streams.** The hub can open a TCP connection to a port on the agent's own machine and carry
  its bytes both ways over the tunnel. Its use is SSH: the machine's own sshd answers on the far end,
  so ssh — and herdr, which reaches a remote machine through ssh — gets to a machine nothing can dial
  into. This too is a capability of the agent rather than a shell command, because a stream is
  bidirectional and lives as long as the connection it carries. The mechanism is described under
  "Carrying a byte stream" below.
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
- The hub's certificate is checked against the machine's own trust store, with a bundled set of
  public roots added for a machine whose store is empty. A network that inspects TLS re-signs the
  hub's certificate with a root of its own that only the machines on it trust, so an agent that
  trusted the bundled roots alone could not reach the hub from such a network.
- Liveness is judged by traffic, not by the socket alone. The agent answers the hub's ping promptly
  and sends its own on an interval, and it treats a stretch of silence from the hub — past a window
  of several intervals — as a dead connection worth redialing, even when the socket has not errored.
- Nothing in flight survives the socket it streamed over. On any loss every running command is
  stopped and every byte stream's connection is closed; neither is resumed across a broken socket,
  and output that a run produces after the loss is dropped rather than sent.
- The hello list names the shells the agent can run, and the shell runner contributes those names
  itself. The core owns the wire — framing, sequence numbers, sending — and the runner owns only
  spawning, streaming, and stopping.
- The agent keeps a bounded rolling log on its own machine, in a per-user location that needs no
  elevation. Because a failure on 하스's box may be exactly that the hub is unreachable, the record
  of what the agent did has to be readable there without the hub; the log rotates by size and keeps
  a fixed number of old files so it cannot fill the disk.
- The installed agent's instance, which its hello carries, is the file `instance` in its data
  directory: made once, by the first run that finds none, and read by every run after, the uninstaller's
  leave notice among them, so the notice is refused while another install holds the name. A data
  directory that cannot be written leaves the agent an id for this run alone.

### The machine's fingerprint

- The machine a hello names is the first 32 hex digits of SHA-256 over the prefix `jake-machine:` and
  the machine's own id, trimmed and lowercased; the raw id never leaves the machine.
- **On Windows** the id is the `MachineGuid` value under `HKLM\SOFTWARE\Microsoft\Cryptography`, read
  through the registry in-process, with no program started.
- **On Linux** it is `/etc/machine-id`, else `/var/lib/dbus/machine-id`.
- **Inside WSL** it is the Windows host's `MachineGuid`, so a WSL agent and a Windows agent of one PC
  name one machine. Reading it from Linux starts a Windows program through interop, and every interop
  start costs Windows dearly, so it is read at most once per agent start and kept, as the fingerprint,
  in the file `machine` in the agent's data directory; every later start reads that file and starts
  nothing. Interop is tried only where its handler is registered. Where it cannot be reached and no
  file stands, the distribution's own machine id stands in for that start and nothing is kept, so a
  later start that reaches interop still keeps the host's. The agent's systemd service may have no
  interop, so the install, run from a WSL shell that has it, keeps the file first (docs/install.md,
  「One jake per machine」).
- The installed agent sends its fingerprint in every hello of its run; the uninstaller's leave notice
  sends none, so a leave is never refused for the machine. The desktop app's built-in agent reads the
  same way, keeping its file, `agent-machine`, beside its instance in the app's config directory.

## Configuration and secrets

- Each side reads a single environment file at startup, and nothing is compiled into a binary. The
  agent's file sits beside its executable; the hub's sits under its data directory, outside the git
  tree. The repository carries only the example files. The desktop app's built-in agent reads no
  file: the app hands it the hub URL, its name and its credential, which it keeps in the operating
  system's credential store (docs/desktop.md, 「The credential's storage」).
- The connection secret and the control token are entered at install time and live only in those
  files. A loader that cannot find a required key reports the key by name and stops — it never runs
  a process against a guessed credential.
- One shared secret authenticates the agent to the hub, presented as a Bearer credential at the
  connection's upgrade. A separate token guards the hub's loopback control API. The two are distinct
  so that the console's reach and the agent's reach are not the same key.
- **An agent may instead present a credential of its own name:** `<name>.<mac>`, where the mac is the
  lowercase hex of HMAC-SHA256 over the name, keyed by the hub's agent key (`JAKE_AGENT_KEY`). The
  hub accepts it only where it holds an agent key and the mac is the name's, and the connection may
  then take that one name: a hello under any other is answered by closing the socket with code 4003,
  and recorded. Whoever holds the agent key mints such credentials — the account service, for a
  machine an invited person installs, and for the machine a person pairs the desktop app with — so a
  person is given a credential for their own machine's name and never the shared secret. A hub with no
  agent key accepts the shared secret alone.
- **A name is revoked for good:** a name credential carries no expiry, so the hub keeps a record of
  revoked agent names in a file under its data directory, read at startup. `POST /revoke?agent=<name>`,
  taken with the control token or a scoped credential whose reach admits the name, records it and,
  where an agent is attached under it, sends that agent a leave at once; it answers 200 with whether
  a leave was sent, and revoking a name already revoked changes nothing. Where an agent presenting a
  name credential says hello under a revoked name, the hub accepts the upgrade and answers the hello
  with a leave instead of a welcome, so the desktop app forgets its credential and offers pairing
  again and an installed agent uninstalls itself, and it records and logs the attempt as a departure.
  A hello never lifts a revocation and no route does: a pairing always binds a fresh name, so a
  revoked name never needs to come back. A hello under a revoked name with the shared secret is the
  administrator's own and attaches as any other. `jake-hub revoked` prints the revoked names the
  configured control credential reaches.
- **A control caller may present a credential scoped to named agents** instead of the control token:
  `<names>.<mac>`, where the names are agent names joined by commas and the mac is the lowercase hex
  of HMAC-SHA256 over that list, keyed by the hub's control key (`JAKE_CONTROL_KEY`). The control
  token is the administrator's and reaches every agent; a scoped credential reaches the agents it
  names and no other. A request naming an agent outside its scope is refused with 403
  `agent-out-of-reach` whether or not that agent is attached, so a holder learns nothing of the
  other machines. A request naming none goes to the one attached agent of its scope. The status and
  the traffic log show its agents alone, a cancel finds only the commands running on them, and a
  listen is asked for or read for them alone.
- The hub knows nothing of accounts. Which machines are one person's is decided by whoever mints the
  credential, from its own record of whose machine each agent name is; `jake-hub credential
  <agent>...` mints one from the hub's own file. A tool that acts for one person is handed a
  credential for that person's machines and never the control token. A hub with no control key
  accepts the control token alone, and a control key equal to the agent key is refused at startup,
  so the credential an agent dials with never doubles as a control credential.
- A refused credential and an unreachable hub are told apart. The hub answers an upgrade with a
  missing or wrong secret with 401 before any socket opens, and writes one line saying where the
  attempt came from and whether the credential was missing or wrong — never the value presented.
  A plain request refused the same way is not an agent's attempt and leaves no line.
  A WebSocket client learns only that the upgrade failed, not its status, so when a dial fails
  before opening the agent asks the same address once more over plain HTTP with the same
  credential: a 401 there is logged as `rejected`, and anything else as `dial-failed`. A name the
  hub turns away arrives after the socket opens, as a rejected frame, and is logged as `rejected`
  too. The installer reads those two events to say whether the secret or name is wrong or the hub
  cannot be reached.

## Staying alive

The agent must come back on its own from a crash and a reboot, so that BMO's link to 하스's machine
survives without anyone tending it. How it comes back depends on the host, because the two platforms
give very different footing for keeping a per-user process running. What follows is the installed
agent's scheme; the desktop app's built-in agent runs while the app runs, is restarted by the app
after a fault, and returns at sign-in only where the person turned that on (docs/desktop.md,
「Keeping the agent running」).

### On a Linux host

- A Linux host has a per-user service manager, so the agent is kept alive the plain way: it runs as a
  `systemd --user` unit that restarts it on failure and starts it at boot. Lingering is enabled for
  the user so the unit runs whether or not that user is logged in, which is the boot-time recovery a
  Windows host cannot get without an administrator account. This is the same shape the hub already
  uses on main-host, so the Linux agent needs no guard, no heartbeat pair, and no anchor rewriting —
  the service manager is the supervisor.
- The unit has no start limit: an agent that keeps exiting is started again a few seconds after each
  exit for as long as it does, since a service manager that gives up leaves the machine detached
  until someone looks.
- A WSL host is Linux only when systemd is running as its init. Where it is not, `systemctl --user`
  cannot register anything, and the install **fails loudly** with that reason rather than writing a
  unit that would never run — enabling systemd in WSL is a host step 하스 takes, not something the
  agent can arrange for itself from inside the session it would run in.
- On WSL, systemd and lingering keep the agent running only while the distribution runs, and WSL stops
  a distribution once no Windows process holds a session into it. The distribution is therefore held
  from the Windows side by a per-user scheduled task, one per distribution, whose action is a session
  that runs `sleep` forever. It starts at logon and on a trigger repeating every five minutes with no
  end, has no run-time limit and runs on battery, the settings the Windows pair's tasks carry, so a
  session that ends for any reason is opened again within five minutes.
- The task takes the least privilege that holds the distribution with no window. It is registered with
  the S4U logon type, which runs it whether or not the user is logged on and stores no password; such
  a task runs in a non-interactive session, so the session it opens has no window anyone could close,
  and its repeating trigger fires from boot on. Windows may refuse an S4U task to an account without
  administrator rights. There the task runs at this user's logon, interactively, and its action is the
  Windows executable in its hold mode: a program of the Windows subsystem, which opens no console,
  starting the session with no window of its own and opening it again a few seconds after it ends.
  The hold puts itself in a job that ends every process in it when the hold ends, so stopping its task
  ends the session too rather than leaving it to hold the distribution. The executable is placed in a folder of its own per distribution, apart from a Windows agent's
  install, whose update or removal therefore leaves it alone.
- A distribution's name holds no space or quote, and `wsl.exe` reads a quoted name with its quotes as
  a name no distribution has, so the name goes into the task's arguments bare.
- The task is registered by the install through Windows interop, which only a WSL session started from
  Windows has; the agent's systemd service has none, so neither an unattended update nor a leave
  reaches it, and the uninstall script, run from a WSL shell, removes it.

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
- Neither process has a console. The executable is built for the Windows subsystem, so whatever
  starts it, a task, the Run value or the Startup shortcut, opens no console window, and no console
  close, Ctrl+C or Ctrl+Break can reach either process. A console program started from an
  interactive task gets a console window of its own, and Windows ends it, writing nothing, with the
  status 0xC000013A when that window closes; two such windows closed together end the pair together.
  Should a console event reach a process all the same, its own handler answers it in place of
  Windows' default: an interrupt, a break or a logoff notice is written to the log and ignored, and a
  console close or a shutdown, which end the process whatever the handler answers, is written to the
  log and stops the run cleanly first.
- Every child the agent starts, a command a caller runs and the helpers the watchdog runs alike,
  starts with a hidden console and a process group of its own, so a console event a child sends to
  its group or its console never reaches the agent.
- Each process watches the other by a heartbeat, not by watching for an exit. On every tick a
  process rewrites the file that records its own liveness and reads the file its peer keeps; a peer
  whose timestamp is older than the staleness threshold — or whose file is missing — reads as dead,
  so a hung peer that never exited is brought back just as a crashed one is. A process finding its
  peer stale relaunches it; every process, on every tick, puts back every autostart anchor that is
  missing, so the wipe of any single anchor is repaired within one tick as long as either process is
  alive. A tick stays cheap: the run entry is read back with a plain `reg query` and written again
  with `reg add` only where the query answers that it is missing or names another command, the
  Startup shortcut is written only where it is missing, and the scheduled task is read back with a
  plain query and registered again, which takes PowerShell, only where the query answers that it is
  missing or its definition differs from the one it must hold.
- A starved machine is never handed more of that work than it finishes. A query that does not answer
  within its bound, ten seconds, says nothing about the anchor it asked after, a run entry or a task,
  which is left as it stands, unregistered that round, until a later tick reads it. Each run entry and
  each task has at most one refresh standing, its query and its registration together: a tick that
  finds the one before still running starts no other, and a registration, a run entry's `reg add` or
  a task's PowerShell, is waited on for at most a minute and ended at that bound. Without that, a
  machine too loaded to answer within the bound is handed a registration of each anchor every minute
  by each process, none of which finishes, and they pile up by the hundred.
- The watchdog runs on a thread and runtime of its own, so starting a helper, waiting on one or
  writing a file, any of which a starved machine can hold up for seconds, never holds up the runtime
  that carries the tunnel. The liveness it records is that runtime's, not its own: the runtime stamps
  a shared moment on every tick and the heartbeat carries that moment, so a hung tunnel runtime reads
  as hung to the peer. Ticks missed while a process could not run are skipped, never run in a burst.
- A hung peer still holds its single-instance lock, and its scheduled task still counts as running, so
  running its task again would start nothing. A process that finds its peer stale while the peer's
  lock names a running copy of this executable therefore ends that copy's whole tree first, then runs
  its task. It does so only once it has ticked without a break for longer than the staleness
  threshold itself: a gap of more than two ticks in its own ticking, as when the machine slept or
  stalled for both, starts its watch over, so a stall the two shared is never read as the peer hanging
  alone and the two never end each other.
- The relaunch runs the peer's scheduled task rather than spawning the peer directly. The Task
  Scheduler service starts the peer on the caller's behalf, so the relaunched peer is not the
  caller's child and shares no teardown boundary with it — the independence the pair depends on. A
  redundant relaunch is harmless because of the single-instance guard below.
- The tick is one minute and the staleness threshold is three minutes — three ticks — both
  configuration rather than constants. Three ticks means a peer is declared dead only after it has
  missed three consecutive heartbeat writes, so one slow or paused tick does not cause a false
  relaunch, while a real death or hang is caught within about three minutes.
- The three anchors are all per-user and need no elevation: a scheduled task with no stored
  credentials, a per-user run entry in the registry, and a shortcut in the Startup folder. Both run
  modes are anchored all three ways — the agent's anchors launch the executable with no argument, the
  guard's launch it with the guard-mode flag — so either can return on its own at logon.
- The pair is the first supervisor and Task Scheduler the second. Each run mode's task starts it at
  logon and also on a trigger that repeats every five minutes, from registration on, with no end, so
  a pair that dies together while the user stays logged on is started again by Task Scheduler within
  five minutes, with neither process alive to do it. A repeat that finds the run mode running is
  dropped: by Task Scheduler where the task's own copy runs, by the single-instance lock where a copy
  another anchor started runs. The task is also started again up to three times, a minute apart,
  after a run Task Scheduler counts as failed; a process that ends with an error code is not always
  counted so, and the repeating trigger is what covers it.
- The consequence of staying per-user is stated plainly: the tasks run only while this user is
  logged on, so after a kill that ends both processes while nobody is logged on, or one that also
  wipes the anchors, recovery is bound to this user's **next interactive logon**, not to the next
  boot. On a machine without auto-logon those are different events, and the gap between them is
  unbounded until someone logs in. Boot-time recovery, or a task that runs whether the user is logged
  on or not, would need an administrator account the install may not have, so neither is used.
- The scheduled task has no run-time limit, and starts and keeps running on battery. Task
  Scheduler's default limit of three days would end both processes together, since they are started
  together. The installer registers the task with these settings, the two triggers and the restarts,
  and a tick that reads back other settings, the defaults among them, registers it again with these.
- Because all three anchors for a run mode fire at the same logon, and the repeating trigger fires
  while it runs, a single logon would otherwise start three copies of it and every repeat one more. A
  single-instance guard prevents that: each run mode takes an exclusive lock on startup, and only the
  copy that takes it runs while the rest exit, writing nothing to the log. The lock is a file created
  atomically — the OS lets exactly one exclusive create win, so even near-simultaneous copies cannot
  both take it — and it holds the holder's process id, so a lock left behind by a crashed process is
  reclaimed once that id is seen to be gone, rather than blocking the binary forever. An id that now
  belongs to another program, as Windows reuses ids, reads as gone too: the holder is a copy of this
  executable or nothing, so a reused id neither blocks the run mode nor is ever ended in its place.
  Only a process this user cannot read at all is left holding the lock.

- The executable takes only the arguments of its run modes: none for the agent, the guard-mode flag,
  the leave flag, the version flag, or the hold flag with a distribution's name. It refuses anything
  else, since a start with a stray argument read as the agent would be a second agent under the
  installed one's name, displacing its connection.

## Leaving

- A leave is a clean, complete uninstall of 하스's own tool, sent from the hub instead of run by hand
  on the machine. It has to be complete for the same reason the staying-alive scheme is thorough: a
  removal that undid only part of the install would be repaired by the part it left running, so
  leaving is a single ordered act that stops every part and removes every file it placed.
- The leave signal reaches the agent over the tunnel — it is the one instruction the hub carries that
  is not a shell command. Only the agent holds the tunnel, so a leave reaches an agent only while it is
  attached, or, for a name the hub has revoked, the next time it says hello (「Configuration and
  secrets」); it reaches only the agent it names, and the others stay installed.
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
- The uninstaller tells the hub the agent has gone, so a removal by hand is recorded as a departure
  just as a leave is. Once it has stopped the agent, and before it deletes the executable, it runs the
  executable once in its leave-notice mode: that process dials the hub with the configured secret
  and name, says hello, and once welcomed sends a leave frame of its own and exits. The agent is
  already stopped, so this hello displaces no live connection. Under a revoked name the hub answers
  that hello with a leave and has recorded the departure itself, so the notice sends nothing, says
  the hub already holds the agent as left, and succeeds. A hub that cannot be reached does not
  stop the uninstall; the uninstaller says the hub was not told and carries on.

## Running commands

- A command runs through one of the host's shells and its output streams back as it is produced,
  chunk by chunk, never held until the command finishes. A program that prints without a trailing
  newline is forwarded as its bytes arrive rather than looking hung waiting for a full line. The
  shells a build offers depend on the host: PowerShell and WSL on a Windows host, a Linux shell on a
  Linux or WSL host. The agent advertises only the shells its own platform can run. A request that
  names a shell the host does not have runs in the host's own instead — the Linux shell on a Linux
  host, PowerShell for anything but WSL on a Windows host — because a caller that names no shell
  sends the console's default, PowerShell, whatever machine it is aimed at.
- PowerShell is run non-interactively, without the user profile, and with the execution policy
  bypassed, so an unattended command neither prompts nor is refused for policy. Its console output is
  forced to UTF-8, so a non-ASCII character crosses the tunnel as itself rather than as mojibake in
  the machine's OEM code page. WSL is entered through its launcher with an optional distribution and
  working directory, and the command runs in a login shell so its environment matches what a person
  gets at an interactive prompt. The launcher is told to start that bash itself rather than hand the
  line to the distribution's default shell, because the default shell would expand the command's `$`,
  quotes and backticks once before bash read it; the command text reaches bash as written, and bash
  alone expands it, the same as on a Linux host. The Linux shell runs the command in a login shell in
  the same way, so its environment likewise matches an interactive prompt.
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
- An upload reaches the hub as a stream, never as one body held whole. The console reads the local
  file once to learn its length and checksum, names both on its request to the control API, and then
  streams the file as the request body; the hub declares those two in the upload's opening frame and
  reads the body only as fast as it hands chunks to the agent's socket, so neither the console nor the
  hub holds more of the file than the chunks in flight, and the control API sets no bound on an
  upload's body. A caller that declares neither the length nor the checksum still has its upload
  taken, at the cost of the hub reading that body whole first to learn both. The hub counts the bytes it streams: a body that runs past the declared length, stops
  short of it, or breaks off fails the transfer and sends the agent an error frame, and the agent's own
  check on the closing frame still refuses content that does not match the declared checksum.
- No upload chunk is sent faster than the connection carries it. Each agent socket on the hub has
  an outbound queue that holds every frame it is handed and counts the bytes not yet written; once
  that backlog passes its limit the hub hands the socket nothing more of the upload until it has
  drained to half the limit, so a file of any size streams at the speed of the link and the hub holds
  no more of it than that backlog. The limit is configuration, `JAKE_HUB_SOCKET_BACKLOG_BYTES`. A
  frame the socket refuses because it is already closing fails the transfer to its caller at once,
  and the hub tells the agent with an error frame naming the transfer, so the agent drops the
  temporary file it was writing rather than holding it until the connection ends. The agent's
  socket holds whatever it is handed without discarding any, so a download needs no pacing.
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

## Carrying a byte stream

- A byte stream joins a caller on main-host to a TCP port on the agent's machine. The caller opens it
  through the control API, naming the agent and the port; the hub sends the agent a stream-open, the
  agent connects to that port on its own `localhost`, the IPv4 loopback first and the IPv6 one where that
  refuses, since a port WSL mirrors onto a Windows host answers on IPv4 alone; from then on the bytes cross
  the tunnel in both directions as stream pieces until either end closes. The frames and the window that paces
  them are stated in docs/protocol.md.
- The machine decides what it exposes. The agent's configuration holds the list of local ports a
  stream may reach, `JAKE_STREAM_PORTS`, which is the SSH port alone unless the install or a hand edit
  says otherwise, and `none` turns streams off. The agent advertises each allowed port in its hello
  and refuses an open for any other, so a hub, or anyone holding its control token, reaches only what
  that machine's own config lets it. The hub reads the advertised ports too and refuses a request
  for a port the agent does not offer before anything crosses the tunnel, so a caller learns at once
  that the agent must be configured, or updated, rather than waiting on a refusal.
- No side holds more of a stream than its window. Each side carries the two directions
  independently, neither waiting on the other, so a slow reader on one end stalls only the bytes
  headed to it: the sender's window fills, it stops
  reading its own end, and the pressure travels back to whoever is writing, as it would over one TCP
  connection. A command or a transfer on the same connection is never held up behind a stream.
- On the agent's machine a stream is a plain local TCP connection, so the program at the port sees a
  client from `localhost`. sshd authenticates that client as it would any other; jake adds no
  credential of its own beyond the hub's, and grants nothing the SSH login does not.
- On main-host the caller is the hub executable run with the connect argument and the agent's name,
  with the port defaulting to SSH's. It reads the control port and token from the hub's own
  configuration, as the console does, opens the stream through the control API, and joins it to its
  standard input and output, writing why the stream ended to standard error. Because that is
  exactly what ssh asks of a `ProxyCommand`, one `ProxyCommand` line in the SSH client configuration
  makes the agent's machine an ordinary SSH host, and herdr's saved SSH machines work on top of it.
  The connect client is a small Rust process rather than a mode of the bun console because it stays
  up for the whole life of the SSH connection it carries, and main-host runs many of them at once.
- A stream lives on the agent's connection. When the agent's socket drops, the hub ends every stream
  on it and the agent closes every TCP connection it opened for one, so ssh sees its connection
  close and can dial again; once the agent has redialled, a new stream reaches the machine as before.


## Carrying a byte stream back

- A stream back joins a program on the agent's machine to a TCP target on main-host: a program that
  connects to a port on the machine's own loopback reaches a service on main-host as if it ran there.
  Its use is what a work node's link carries the other way — the tool host's port and the home bridge
  — so a machine reached through the hub alone needs no SSH for it.
- The hub decides where a stream back may go, and the machine decides where it may listen. The hub's
  configuration holds the targets a stream back may reach, `JAKE_REVERSE_TARGETS`, none unless set; a
  caller names one for a port of an agent through the control API, and the hub refuses any other. The
  agent's configuration holds the ports it may listen on, `JAKE_LISTEN_PORTS`, none unless set; the
  agent advertises each in its hello and refuses a listen on any other. The agent listens at its
  loopback alone, so nothing beyond the machine reaches the port.
- A caller asks through the control API: `POST /listen?agent=<name>&port=<port>` with `target` in its body
  listens for that agent on that port, `DELETE /listen?agent=<name>&port=<port>` stops, and `GET
  /listens?agent=<name>` answers what the hub holds for the agent, each port with its target and whether
  the agent listens on it now. Asking again for a port the agent already listens on keeps that listen
  standing, takes the target named this time, and answers `standing: true`; the agent is asked to
  listen again only where it does not listen yet, which the answer gives as `standing: false`. A target the hub does not allow is refused 403 `target-not-allowed`; a port
  the agent does not offer, 403 `port-not-offered` once the agent is attached.
- The hub keeps what it was asked to listen for, by agent and port, for as long as it runs: it asks the
  agent to listen as the agent attaches, and again on every later connection, so a machine that
  dropped listens again once it is back. A caller asks again after the hub itself restarts.
- Each connection the agent accepts is a stream of its own, carried and paced as a stream the hub
  opened is (「Carrying a byte stream」), and joined on main-host to a fresh connection to the target.

## The console

- 하스 must be able to see, from a console, which agents are attached and whether commands are
  moving. A command-line tool against the hub's loopback control API is the primary surface — it is
  also the handle a headless session on main-host uses to drive the agent, so no change inside 비모
  is required. A thin read-only web page over the same API shows connection state and recent traffic.
- Both surfaces read the control token from the hub's configuration, not from an argument. A CLI run
  with `JAKE_CONTROL_CREDENTIAL` in its environment presents that scoped credential instead, so a
  tool acting for one person reaches that person's machines alone. The CLI
  runs one command and returns the agent's own exit code for an `exec`, so a caller branches on it as
  it would on a local shell; the page only reads and offers no control the CLI does not. The CLI also
  moves a whole file across the tunnel in either direction — an upload of a local file onto the
  machine, a download of a file on the machine back to main-host — each verified against its checksum
  before it is reported done, and a download written to its local path only once that check passes. It
  also carries the leave command that uninstalls the agent remotely; because it is irreversible, the CLI refuses it
  unless the intent is stated outright, and the read-only page cannot trigger it at all. Every CLI
  command that reaches a machine takes the target agent's name, which may be left out only while a
  single agent is attached.
- The CLI has two forms. The bun console carries every command. The hub executable carries `exec` as
  well, with the same flags and the same exit codes, and passes a Ctrl-C on as a cancel, so running a
  command on a machine needs only the Rust binary and no bun.
- The page is the one route of the control API served without the token: a browser navigation cannot
  attach a bearer header, so the page comes back open and carries the token embedded in it, which its
  own read requests then present. This is safe because the control API binds to loopback alone —
  anyone able to load the page is already on the machine and could read the token from the config
  file. Every other route still demands the token or a scoped credential.

## The build and the install

- The executable is cross-compiled from main-host for both hosts — a Windows target and a Linux
  target — with zig as the linker and C compiler, so no Windows toolchain and no separate Linux
  machine are needed to produce them. Each is a single self-contained file: the Linux binary links
  its C library statically, so it runs on any distribution or WSL whatever C library that has. The
  build version is stamped into it at compile time — the agent run mode announces it to the hub.
  The build's output is a small layout: the Windows executable, the Linux binary, the example
  config, the install scripts for both platforms, and the install guide. Nothing else is bundled, because the agent needs nothing beyond the shells
  already on the machine.
- The build layout is served at the deployment's own download address, `JAKE_AGENT_DOWNLOAD_URL` of the hub's
  settings, so a machine installs with a single command that needs nothing downloaded by hand first. On
  Linux/WSL it is `curl -fsSL <download address>/install.sh | bash`; on Windows it is `powershell -c "irm
  <download address>/install.ps1 | iex"`. Each install script fetches the binary for its own platform — the
  Linux binary `jake`, the Windows executable `jake.exe`, both under the same address — along with the example
  config it needs. The scripts name no address of their own: the deployment writes its download address and its
  hub's public address, `JAKE_PUBLIC_URL`, into them as it publishes, so a copy no deployment published downloads
  nothing and offers no hub. Each deployment of the hub
  builds that layout from the commit it deploys, carries it in the release, and publishes it there
  once the hub answers (docs/deploy.md, sections 8 and 9), so the download is always the agent build
  of the commit the hub runs. The layout names its own version in `version.txt`, written last when it
  is published, so a reader that finds the version it wants there finds the rest of that build too.
- The installer runs in 하스's own user session without elevation. It places the binary in a per-user
  location and writes the hub URL, the shared secret, and the agent name into the config file beside
  it — the credential is entered at install time and exists only in that file, never in the repository
  and never in the executable. The file is written as UTF-8 without a byte order mark, and the agent
  skips one at its start all the same, since a Windows editor may save the file with one. It then registers the agent so it stays running by the means the host
  offers: on Windows all three anchors for both run modes, starting the pair; on Linux a
  `systemd --user` unit with lingering enabled, started at once, failing loudly where systemd is not
  available. It verifies by reading the agent's own local log for a record that it reached the hub,
  because the installer runs on 하스's machine and cannot reach the hub's loopback control API.
- The desktop app is the other way a machine is joined, and is built and distributed apart: an
  installer for the current user alone, published as releases of the public repository, which
  connects to the server its person names and learns that server's hub as it pairs, with updates
  through Tauri's updater (docs/desktop.md, 「The server」 and 「Distribution and updates」). The one-line install stays as it is beside it, and the two never run
  under one name together (docs/desktop.md, 「One agent per name」).
- The install is re-runnable over an existing one without duplicating its registrations: on Windows
  each anchor is overwritten in place and a running pair is stopped before its executable is replaced
  and started again after; on Linux the unit is refreshed and restarted. Hand-edited tuning keys in
  the config are preserved either way. The uninstaller reverses it — stopping the agent, removing its
  registrations, and deleting the layout — and leaves removing the config an explicit choice, so a
  reinstall keeps the hub URL and secret unless they are asked to be dropped.

## Keeping the agents current

- An installed agent follows the hub's release without a hand at its machine. A hub reads, at start,
  the version of the agent build its release carries, and orders onto that build every attached agent
  that announces another installed build, one whose version carries the commit the install's build
  stamps in. The desktop app's built-in agent announces a version of its own kind and is updated by the
  app's own updater, so it is never ordered; neither is a development build that carries no commit.
- The order is an ordinary command, not a frame of its own, because the agents that need the update
  are exactly the ones that may not know a new frame; every agent runs a command. The hub picks the
  command by the shells the agent offers: PowerShell means a Windows host, the Linux shell a Linux
  host, and an agent offering neither is left alone.
- The command cannot do the replacing itself: the agent running it is the process to be stopped, and a
  call left waiting on its own agent would hang until the socket dropped. So the command only hands
  the work to a runner the platform owns, the same way leaving hands its file deletion to one, and ends
  at once with the exit the hub reads. On Windows that runner is a one-shot scheduled task, which
  deletes itself when it is done; on Linux a transient unit of the user's service manager, outside the
  agent's own unit, so stopping the agent's unit does not stop it.
- On Windows nothing of the update runs from a script file. A managed PC's software restriction policy
  can block every `.ps1` file PowerShell is asked to load, whatever execution policy the command line
  names, while script text passed inline still runs, as every command the agent runs is passed. So
  the task starts PowerShell with the runner encoded on its command line, and the runner hands the
  downloaded install script to a second PowerShell as text, never by its path.
- The runner installs exactly as a person re-running the install would, in the install's update mode:
  it stops the agent, replaces the binary, refreshes every registration, starts it again, and keeps
  the config. The new build must come back attached, so that mode keeps the previous binary until the
  new one reports a connection and puts it back where none comes, ending with an error. On Windows
  the wait counts from the new build's first log line, so a build whose launch is held up, as a first
  scan of a newly written executable may hold it, is not taken for one that cannot reach the hub.
- An update never ends with the agent stopped. Whatever fails once the install has stopped it, the
  swap, a registration or the rollback, the install leaves an executable in place and starts the agent
  again before it ends, on Windows the guard with it. On Linux everything is downloaded before the
  unit is stopped. On Windows the install waits until the stopped processes have exited, since a
  killed process holds its executable, and its task's instance refuses a new start, until it has; and
  it never overwrites the executable but renames the one in place aside first, which Windows allows
  even while that file still runs, and renames it back where the swap fails. The runner starts the
  agent, and on Windows the guard, once more whenever the install ends in failure.
- A deployment restarts the hub before it publishes the agent build, so an agent can be ordered onto a
  build the download does not offer yet. The runner therefore waits, bounded, until the published
  version is the one it was ordered onto, and changes nothing when it never is.
- An update stops whatever the agent carries, so the hub orders it only while no command and no
  transfer a caller started is running there, and otherwise asks again at each ping. Byte streams do
  not hold it back: an ssh session may stay open indefinitely, and it is dropped and redialled the same
  way a hub restart drops it. Once ordered, an agent is not ordered again for an hour, so a build that
  cannot reach a machine is retried rather than looping. The hub logs each order and its command's end.

## The hub on main-host

- The hub runs permanently on main-host as a systemd **user** service, restarted on failure and
  brought up at boot once lingering is enabled for the user. The unit runs the release binary in the
  deploy tree, which BMO's testbed builds from the commit it deploys, so the hub runs exactly the
  deployed commit and nothing in a checkout or its build directory. ssh's proxy and the CLI on the
  PATH call that same binary, so a deployment moves all three at once.
- The hub is one thread. Everything it does is relaying — frames in, frames out, a running hash over
  a download — so it waits on sockets rather than on the processor, and an idle hub with every agent
  attached sits at a few megabytes. Every accepted connection sends each write at once, without
  waiting to batch it, because each write is a whole frame or event and a held write costs a
  round trip its delayed acknowledgement. It does not start until its config file
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
- 하스's network reaches the hub at its public name (`HUB_NAME`, docs/deploy.md): a Cloudflare CNAME to `home.example.org`, DNS only,
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
