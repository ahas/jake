# jake architecture

jake is a remote-control agent that 하스 installs on his own Windows box and that 비모 drives from
main-host. This document is the canonical statement of how the pieces fit; the code answers to it.

## The problem it solves

- The network runs one way. 비모's side cannot reach into 하스's Windows environment, so nothing on
  main-host can open a connection inward.
- Therefore the agent dials **outward**. It opens one connection to the hub and holds it, and every
  command and every result travels over that one connection, in both directions. This is why the
  connection feels like an SSH session even though 비모 never dialed in.

## The three programs

- **hub** — runs permanently on main-host as a systemd user service. It accepts the single agent's
  outbound connection, and it exposes a loopback control API that the console and 비모 drive it
  through. It is reachable from 하스's network through a `*.ahas.io` name fronted by NPM. It holds no
  capability itself; it relays.
- **agent** — runs on 하스's Windows box. It dials the hub, authenticates, and then runs whatever the
  hub sends: PowerShell and WSL commands with live-streamed output, a screen capture, a fetch from
  inside 하스's LAN, and browser control. It listens for nothing; it only dials.
- **browser sidecar** — a separate, uncompiled program the agent spawns as a child when a browser
  capability is first used. It owns the browser and talks to the agent over its own standard input
  and output.

## Why the browser lives outside the compiled agent

- The agent ships as a single compiled Windows executable. Building it that way is what makes the
  install one file 하스 runs, with no toolchain on his machine.
- The browser-automation library cannot be compiled into that executable: the compile step fails
  while bundling it, against a defect that is open upstream and has no accepted workaround. Even if
  the bundling succeeded, the browser binary the library drives is hundreds of megabytes that no
  compiled bundle carries — it is downloaded separately at install time.
- So the browser capability is split out. The installer lays the sidecar down as its own directory,
  with its own dependencies and its own downloaded browser, beside the agent's executable. The agent
  starts it lazily on the first browser call, talks to it over a line protocol on its standard
  streams — no extra listening port on 하스's machine — and shuts it down after an idle period so a
  browser is not sitting in memory for nothing.
- If the sidecar directory is absent or its browser was never downloaded, the agent simply does not
  offer the browser capability, and a browser call comes back as a stated error rather than a crash.

## The browser sidecar

- The sidecar answers a small line protocol on its standard streams: one JSON request per line in,
  one JSON response per line out, each response carrying the id of the request it answers so the
  agent can correlate them. Binary — a screenshot's PNG — rides inside a response as base64 with its
  declared byte length, the same way the tunnel's own frames carry bytes. A request the sidecar
  cannot parse carries no id to answer and is skipped rather than crashed on.
- It exposes five methods: navigate a page, read its source, screenshot it, evaluate an expression
  in it, and fetch from inside its context so the page's own origin and cookies apply. Each is its
  own named capability on the tunnel rather than one browser call switching on a parameter, so the
  hello list names exactly what the agent can do and each is invoked directly. All of them share the
  one browser the sidecar owns: a single browser, a single context, and a single page, created lazily
  on the first call that needs a page.
- The sidecar processes requests one at a time. A single page cannot serve two overlapping
  navigations, so a second request waits for the one before it to answer.
- The agent supervises the sidecar as a child process and never lets one failure become a crash.
  When the sidecar is not installed the browser methods are still registered — so a call that arrives
  is answered — but they are kept out of the hello list, and the answer is a stated error naming how
  to install it. When the child dies while calls are waiting, every waiting call fails with the
  reason and the next call starts a fresh child. A call that never answers is bounded by a wall-clock
  timeout, and reaching it tears the child down so the next call is served by a new one rather than
  queuing behind a wedged page. The child is shut down after an idle period and started again on the
  next call.
- The sidecar drives the browser shipped in its own directory rather than a machine-wide cache, so it
  is self-contained: it points its browser-automation library at that co-located download. The agent
  counts the capability as installed only when both the sidecar's entry and its downloaded browser
  are present; a directory without the browser is treated as not installed, so the capability is not
  advertised until the browser is really there. A screenshot the sidecar returns is subject to the
  same frame payload cap every binary result answers to.

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
  stopped and every pending call is abandoned; a command is never resumed across a broken socket,
  and a result that arrives from a handler after the loss is dropped rather than sent.
- What the agent can do is exactly what its build registered. Each capability the build carries
  registers itself and contributes its own name to the hello list; a capability the build omits is
  absent from that list rather than a branch the core carries. The core owns the wire — framing,
  sequence numbers, sending — and a capability owns only its work.
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

- 하스's Windows environment resets from time to time, and a reset can wipe a scheduled-task entry.
  The agent must come back on its own from a crash, a reboot, and the deletion of any one autostart
  registration.
- The pair is two different programs. **jake-agent.exe** carries the tunnel and every capability;
  **jake-guard.exe** is a small supervisor that carries none. They are separate binaries with
  separate names — and so separate hashes — on purpose: a single `taskkill /IM`, one antivirus
  signature on a running image, or one job-object teardown cannot end both at once, and the survivor
  brings the other back. Because the guard holds no capability, its crash surface and its attack
  surface both differ from the agent's, not only its name.
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
  Both binaries are anchored all three ways, so either can return on its own at logon. The
  consequence of staying per-user is stated plainly: after a kill that ends both processes and wipes
  the anchors, recovery is bound to this user's **next interactive logon**, not to the next boot. On
  a machine without auto-logon those are different events, and the gap between them is unbounded
  until someone logs in. Boot-time recovery, or a task that runs whether the user is logged on or
  not, would need an administrator account the install may not have, so neither is used.
- Because all three anchors for a binary fire at the same logon, a single logon would otherwise start
  three copies of it. A single-instance guard prevents that: each binary takes an exclusive lock on
  startup, and only the copy that takes it runs while the rest exit. The lock is a file created
  atomically — the OS lets exactly one exclusive create win, so even near-simultaneous copies cannot
  both take it — and it holds the holder's process id, so a lock left behind by a crashed process is
  reclaimed once that id is seen to be gone, rather than blocking the binary forever.

## Running commands

- A command runs through one of two shells on 하스's box — PowerShell or WSL — and its output streams
  back as it is produced, chunk by chunk, never held until the command finishes. A program that prints
  without a trailing newline is forwarded as its bytes arrive rather than looking hung waiting for a
  full line.
- PowerShell is run non-interactively, without the user profile, and with the execution policy
  bypassed, so an unattended command neither prompts nor is refused for policy. Its console output is
  forced to UTF-8, so a non-ASCII character crosses the tunnel as itself rather than as mojibake in
  the machine's OEM code page. WSL is entered through its launcher with an optional distribution and
  working directory, and the command runs in a login shell so its environment matches what a person
  gets at an interactive prompt.
- Stopping a command ends its whole process tree, not only the shell that was launched: a shell that
  started something else must not leave that behind. A caller's cancel is reported as a cancel,
  distinct from a natural exit.
- Two caps guard the hub against a runaway command: a ceiling on total output and a wall-clock ceiling
  on how long it may run. Reaching either stops the command and states the reason as a final line of
  the command's output, so a recursive listing of a whole drive cannot flood the hub. A cap or a
  timeout stop is jake's own doing, so it is not reported as a caller's cancel. Both ceilings are
  configuration, not constants.

## Screen capture

- A screenshot is taken by a spawned helper, not a native library bound into the agent: a native
  screen-grab addon carries its own reported instability under the agent's runtime and gains nothing
  here. The primary helper is a short PowerShell script that copies the screen into a bitmap and
  saves a PNG to a temp file the agent then reads back and returns.
- A capture can name the whole desktop or a single monitor by its device name. The whole desktop is
  the virtual-screen rectangle spanning every monitor; a named monitor is looked up by that name and
  a name that matches nothing is a stated error rather than a blank image.
- A bundled nircmd.exe is the fallback for the case where machine policy blocks the PowerShell path.
  It is laid down beside the executable at install time; when it is absent the handler still runs and
  reports a stated error instead of falling back. nircmd captures the whole desktop only, so a
  fallback capture is always every monitor even when one was asked for — the result says both what
  was requested and what was actually captured.
- The PNG is subject to the same frame payload cap every binary result is: an image larger than the
  cap is refused rather than sent, and the temp file is removed whichever way the call ends.

## Fetching from inside the network

- The agent can make an HTTP request from where it runs, so a URL reachable only from 하스's LAN can
  be retrieved through the tunnel. The request's method, headers, and body go in; the response's
  status, headers, and body come out, along with the final URL and the chain of any redirects.
- Redirects are followed by hand up to a bounded count, never silently past it — an over-long chain
  is a stated error. The method and body are reshaped across a redirect the way a browser does: a
  see-other continues as a bodyless GET, a moved/found turns a non-GET into a bodyless GET, and a
  temporary/permanent redirect preserves the method and body exactly.
- A textual body comes back as a string in the result; a binary body comes back as a base64 blob
  labelled with its content type, because the two travel differently over the wire. An unlabelled
  body is treated as binary. The body is read against a cap and a response past it is refused rather
  than buffered whole, and a binary body past the frame payload cap is refused as well. Both the body
  cap and the redirect bound are configuration, not constants.

## The console

- 하스 must be able to see, from a console, whether the agent is attached and whether commands are
  moving. A command-line tool against the hub's loopback control API is the primary surface — it is
  also the handle a headless session on main-host uses to drive the agent, so no change inside 비모
  is required. A thin read-only web page over the same API shows connection state and recent traffic.
- Both surfaces read the control token from the hub's configuration, not from an argument. The CLI
  runs one command and returns the agent's own exit code for an `exec`, so a caller branches on it as
  it would on a local shell; the page only reads and offers no control the CLI does not.
- The page is the one route of the control API served without the token: a browser navigation cannot
  attach a bearer header, so the page comes back open and carries the token embedded in it, which its
  own read requests then present. This is safe because the control API binds to loopback alone —
  anyone able to load the page is already on the machine and could read the token from the config
  file. Every other route still demands the token.

## The build and the install

- The two binaries are cross-compiled for Windows from main-host, so no Windows toolchain is needed
  to produce them. Each is a single self-contained executable with the runtime embedded, and the
  build version is stamped into both at compile time — the agent announces it to the hub and the
  guard records it in its log. The browser sidecar is not compiled, for the reason stated above, so
  the build's output is a layout folder rather than a lone file: the two executables, the sidecar
  directory with its dependencies but without the downloaded browser, the screenshot fallback binary,
  the example config, and the install scripts.
- The installer runs in 하스's own user session without elevation. It copies the layout to a per-user
  location, and it is what asks for the hub URL, the shared secret, and the agent name and writes
  them into the config file beside the executable — the credential is entered at install time and
  exists only in that file, never in the repository and never in a binary. It can optionally set up
  the browser sidecar: fetch a runtime for it and download its browser. It registers all three
  anchors for both binaries, starts the pair, and then verifies by reading the agent's own local log
  for a record that it reached the hub — the installer runs on the Windows box and cannot reach the
  hub's loopback control API, so the confirmation is read locally.
- The install is re-runnable over an existing one without duplicating anchors: each anchor is
  overwritten in place, a running pair is stopped before its executable is replaced and started again
  after, and hand-edited tuning keys in the config are preserved. The uninstaller reverses it —
  stopping the pair, removing all three anchors for both binaries, and deleting the layout — and
  leaves removing the config an explicit choice, so a reinstall keeps the hub URL and secret unless
  they are asked to be dropped.

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
