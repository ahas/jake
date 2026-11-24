# Installing the jake agent

- jake is a **bmo agent proxy**: the proxy through which BMO manages one of 하스's own machines. It
  opens a tunnel outward to the hub on main-host, and once attached the hub side runs shell commands
  and moves files on that machine.
- It installs on either kind of host — a Windows box, where it runs PowerShell and WSL commands, or a
  Linux/WSL box, where it runs a Linux shell.
- This guide is how 하스 installs, updates, and removes it on his own machine.
- The desktop app is the other way: BMO's web console as an app of its own that carries the agent
  inside it and is joined by approving it in the console, with no secret typed. It is described in
  docs/desktop.md; this guide is the one-line install, which works as it always has beside it. Give
  the two different machines, or one of them alone: on a machine where an installed agent runs, the app
  keeps its own agent off.
- No administrator rights are needed. Everything runs in his own user account.

## One-line install

The install scripts and the binaries are served at your own hub's download address, the
`JAKE_AGENT_DOWNLOAD_URL` its deployment publishes at (docs/deploy.md, 「9. The agent downloads」), so one
command installs from a clean machine.

- **Linux or WSL** — from a shell:

  ```sh
  curl -fsSL <download address>/install.sh | bash
  ```

- **Windows** — from a PowerShell window:

  ```powershell
  powershell -c "irm <download address>/install.ps1 | iex"
  ```

The script fetches the binary for the machine's platform (`jake` on Linux, `jake.exe` on Windows, under the
same address), writes the config, registers the agent so it stays running, and starts it. What it needs is
below.

### Where the agent comes from

- **The scripts in the repository name no address.** Every deployment of the hub writes its own download
  address and its hub's public address, `JAKE_PUBLIC_URL`, into the copies it publishes. A copy no deployment
  published downloads nothing, so it runs from a build folder alone, and it offers no hub: the hub URL must be
  given.

## What it asks

The install needs three values, and nothing more:

- **Hub URL** — the hub to attach to. An empty answer takes the hub of the deployment that published the
  script; a copy no deployment published has none, and an empty answer stops the install.
- **Shared secret** — the secret the hub also holds. It is not shown while typed.
- **Agent name** — this agent's name, which is how the hub and the console tell this machine from
  the others. The hub holds one connection per name and one agent per machine: give every machine its
  own name, and every machine one install (「One jake per machine」).

Run interactively, the script asks for the three; the secret and the name have no default and must
be given. On a re-run the values already in `agent.env` are offered instead, and an empty answer
keeps them. To install without prompts, pass them as arguments (the hub URL may be left out where the
published script names one):

- Linux/WSL: `curl -fsSL <download address>/install.sh | bash -s -- --hub-url wss://<hub name> --secret '<shared secret>' --agent-name '<this agent name>'`
- Windows: run `install.ps1` with `-HubUrl wss://<hub name> -Secret '<shared secret>' -AgentName '<this agent name>'`.

Both also take `--replace` (Linux/WSL) or `-Replace` (Windows), which replaces another jake already on
this machine rather than refusing (「One jake per machine」).

The shared secret is written only to that machine's config file (`agent.env`). It is in neither the
repository nor the executable.

## One jake per machine

One physical PC carries one jake agent, whatever its names and its sides: a Windows install and an
install inside one of its WSL distributions are two agents of one machine, and the hub attaches only the
first (docs/architecture.md, 「Many agents, one hub」). So before it installs, the install looks for another
jake serving this machine, and refuses to add a second one.

- **What it looks at,** before anything is stopped or written, with as few programs started across
  the WSL boundary as it can — each such start costs Windows dearly: from WSL, at most the one read of
  the fingerprint through interop, and from Windows one `wsl.exe` call:
  - **From WSL** (`install.sh`): a Windows install, an executable with an `agent.env` naming an agent in
    `AppData\Local\Programs\jake` of any account under `C:\Users`, read through `/mnt/c` with no Windows
    program started. The BMO desktop app set up on Windows, its `settings.json` naming a server, is said
    as a note: its built-in agent's name is kept in Windows' credential store, which the install does
    not read, and the hub's answer below names it where it is attached. Another WSL distribution's
    install is seen through the hub's answer alone, since every distribution of a PC reports the
    Windows host's fingerprint.
  - **From Windows** (`install.ps1`): the default WSL distribution, through one `wsl.exe` call that
    prints the name in its `jake-agent` install, where the unit is registered, and the ports listening
    there; and the BMO desktop app's `settings.json`, said as a note as above. The desktop app keeps its
    own agent off beside an installed one it sees (docs/desktop.md, 「One agent per name」).
  - **The hub's answer:** the new executable, run as `jake --machine-check` with the values being
    installed, reads this machine's fingerprint (on WSL through interop, once, keeping it in the data
    directory, where the agent's service then reads it with no interop of its own) and asks the hub
    whether an attached agent holds it. The hub names its holder; a holder of another name than the
    one being installed is another jake on this machine. A hub that cannot be reached, or does not
    answer the question, leaves the local look alone to decide.

  An install in the same place as this one, `~/.local/share/jake` in this distribution or the install
  folder on Windows, is this install run again, not a second one, and is replaced as always.
- **What it says.** Another jake found, the install stops before changing anything and names it, where
  it is and under what name, with the two ways on:
  - **Join it:** do nothing more here. This machine is that install's node; the BMO administrator binds
    the account that wanted this install to that node as a shared node.
  - **Replace it:** run the install again with `--replace` (Linux/WSL) or `-Replace` (Windows). The
    other install's own uninstaller runs first — a Windows install's `uninstall.ps1` from WSL through
    interop, a WSL install's `uninstall.sh` from Windows through `wsl.exe` — which stops it, tells the
    hub it left and keeps its `agent.env` (「Uninstall」); then this install goes on. A holder the hub
    names that the install cannot reach from here, another WSL distribution or the desktop app, is not
    removed: the install says to run that one's uninstaller where it is, or to quit the desktop app,
    and stops.
- **An update looks at none of this.** `--update` and `-Update` refresh the install already on the
  machine, so they never stop for another.

### Ports

An install never takes a loopback port another program on the machine holds. The agent listens only on
the ports `JAKE_LISTEN_PORTS` names (「SSH over the tunnel」), and under WSL's mirrored networking a
Windows program and a WSL program share one loopback, so a port one side holds the other cannot take.
Before it stops anything, the install checks each of those ports on both sides — on Linux with
`ss -ltn`, on Windows with `Get-NetTCPConnection -State Listen`; from WSL the Windows side through one
more interop call made only for those ports, and from Windows the WSL side through the one `wsl.exe`
call above — and where something other than the agent being replaced listens there, it stops,
naming the port and the program holding it. With no `JAKE_LISTEN_PORTS`, the default, there is nothing
to check and nothing is started for it. An update refreshes the agent already listening there, and checks
none of them.

## Installing from a build folder

The one-liner is the download-and-run form of the same scripts. Given a build folder produced by the
build, run the script inside it instead. The folder holds the binaries for both platforms, the
example config, the install and uninstall scripts, this guide, and `version.txt`, the version stamped
into both binaries.

- **Linux/WSL** — `./install.sh` from inside the folder.
- **Windows** — `.\install.ps1` from a PowerShell window inside the folder. If script execution is
  blocked because this is the first script opened, allow it for that window only and run it again:

  ```powershell
  Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
  .\install.ps1
  ```

- The default install location is `%LOCALAPPDATA%\Programs\jake` on Windows and a per-user path such
  as `~/.local` on Linux.
- Running the install again over an existing one is safe: registrations are refreshed rather than
  stacked, the running agent is stopped and comes back up as the new build, and values edited by hand
  in `agent.env` are kept.

## Linux and WSL: how it stays running

- On a Linux host the agent runs as a `systemd --user` service. The install enables it and turns on
  lingering for the user (`loginctl enable-linger`) so the service starts at boot and runs whether or
  not that user is logged in, and restarts on its own five seconds after any exit, however often it
  exits.
- **On WSL the distribution itself has to stay running,** and WSL stops a distribution, with every
  service in it, once no Windows program holds a session into it. So an install run from a WSL shell
  also registers a scheduled task on the Windows side, `JakeWsl-<distribution>`, that holds a session
  open with no window. Like the Windows agent's tasks it starts at logon and again every five minutes
  while it is not running, with no run-time limit and on battery, so closing any terminal, locking the
  screen or an ended session does not stop the distribution for longer than that.
- Where Windows lets this account register it so, the task runs **whether or not the account is logged
  on, with no password stored** (the S4U logon type): it holds the distribution from boot, before
  anyone logs on, and the install says so. Where Windows refuses that, as it may for an account
  without administrator rights, the install places the Windows jake executable under
  `%LOCALAPPDATA%\Programs\jake-wsl\JakeWsl-<distribution>` and registers the task to run it in its
  windowless hold mode from **this account's logon** instead, and says that and why Windows refused.
- The task is registered through Windows interop, which a WSL shell has. An unattended update runs
  inside the agent's systemd service, which has no interop, so an update leaves the task as it is;
  running the install again from a WSL shell registers it afresh.
- **WSL is Linux only when systemd is running as its init.** Where it is not, the install cannot
  register a user service and stops with a clear message rather than leaving an agent that never comes
  back. Enabling systemd in WSL is a host step 하스 takes himself: set `[boot] systemd=true` in
  `/etc/wsl.conf`, then run `wsl.exe --shutdown` from the Windows side so the distribution restarts
  with systemd — this cannot be done from inside the WSL session the agent would run in. After that,
  run the install again.

## Windows: how far it comes back on its own

- Two programs — the agent and a small guard — watch each other. When one dies or hangs the other
  brings it back, and every minute both check the three autostart anchors: a logon scheduled task, a
  registry Run value, and a Startup-folder shortcut. A deleted anchor, or a task whose settings were
  changed, is restored within a minute as long as either program is alive.
- A program that hangs without exiting is ended, with everything it started, before it is started
  again, about three minutes after it stopped answering. When the whole machine stalls or sleeps, both
  programs wait out three more minutes of their own before either judges the other, so the two never
  end each other over a stall they shared.
- The checks every minute run apart from the agent's connection to the hub, so a machine slow to start
  a program does not hold the connection up.
- Neither program opens a window, so there is no console window to close by accident, and closing a
  terminal or pressing Ctrl+C anywhere does not stop them.
- If both programs die together while this account is logged on, Task Scheduler starts them again
  within five minutes: each scheduled task repeats every five minutes, and a start that finds its
  program already running is dropped. It also starts a task again up to three times, a minute apart,
  after a run it counts as failed.
- The scheduled tasks have no run-time limit and run on battery, so Task Scheduler never ends the
  pair on its own after a few days.
- All three anchors belong to **this user account**. They register without administrator rights, and
  so they fire when **this account logs on**, and repeat only while it stays logged on, not at boot
  itself.
- If both programs die together while nobody is logged on, or the anchors are wiped as well, jake
  comes back at **this account's next logon**. On a machine without auto-logon, boot and logon are
  different events; while the machine sits powered on with nobody logged in, jake stays down for that
  stretch.
- **With auto-logon on**, boot is logon, so jake comes back on its own after a reset or reboot with no
  one touching it. On a machine that resets often, auto-logon makes recovery certain.
- Starting at boot before logon needs an administrator account, and the install stays without
  administrator rights, so it is not used — the boot-time recovery a Linux host gets from systemd is
  the trade a Windows host makes for staying per-user.

## SSH over the tunnel

BMO on main-host reaches this machine with ssh, and herdr with it, through the tunnel: the hub opens
a connection to a port on this machine and carries its bytes, so nothing has to dial in. For that
the machine needs an SSH server listening on it, and the key main-host logs in with.

The agent lets the hub reach only the ports listed in `JAKE_STREAM_PORTS` in `agent.env`, port 22
by default. It listens for streams back only on the ports listed in `JAKE_LISTEN_PORTS`, none by
default, at its loopback alone (docs/architecture.md, 「Carrying a byte stream back」). The install takes two options for this, and both may be left out:

- **Stream ports** — `--stream-ports 22` (Linux/WSL) or `-StreamPorts 22` (Windows): the ports, comma
  separated, or `none` to refuse every stream. Left out, `agent.env` keeps what it has.
- **SSH key** — `--ssh-key '<public key>'` (Linux/WSL) or `-SshKey '<public key>'` (Windows): the
  public key main-host logs in with, added to this account's `~/.ssh/authorized_keys` if it is not
  there yet.

The install warns when nothing answers on a listed port, because a stream to it would fail. The SSH
server itself needs administrator rights to install, so it is a step taken by hand, once.

### Linux and WSL

1. Install and start the OpenSSH server:

   ```sh
   sudo apt install openssh-server
   sudo systemctl enable --now ssh
   ```

   On a WSL distribution this needs systemd running as its init, the same condition the agent itself
   needs. Inside WSL the server listens in the distribution, which is where the agent connects.
2. Run the install with the key, or add it to `~/.ssh/authorized_keys` by hand:

   ```sh
   curl -fsSL <download address>/install.sh | bash -s -- --ssh-key 'ssh-ed25519 AAAA... user@main-host'
   ```

3. Check that something answers: `ssh localhost true` on this machine.

### Windows

1. From an elevated PowerShell, install and start the OpenSSH server and have it start at boot:

   ```powershell
   Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
   Start-Service sshd
   Set-Service -Name sshd -StartupType Automatic
   ```

2. Run the install with `-SshKey '<public key>'`. For an account in the Administrators group, the
   OpenSSH server reads the keys from `C:\ProgramData\ssh\administrators_authorized_keys` rather
   than the account's own file, so the install says so, and the key goes there from the elevated
   PowerShell:

   ```powershell
   Add-Content -Path C:\ProgramData\ssh\administrators_authorized_keys -Value 'ssh-ed25519 AAAA... ahas@main-host'
   icacls C:\ProgramData\ssh\administrators_authorized_keys /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F'
   ```

3. A stream reaches the server from `localhost`, so it needs no opening in the Windows firewall.

How main-host uses the stream — the `ProxyCommand` line and herdr's saved machines — is in
docs/recipes.md.

## Checking it worked

The install starts the agent, watches briefly whether it reaches the hub, and reports:

- **connected to the hub** — attached. Done.
- **the hub rejected the agent** — the hub answered but refused the shared secret or the agent name.
- **another jake holds this machine** — the hub refused the agent because an agent of another name on
  this machine is attached (「One jake per machine」).
- **could not reach the hub** — no answer came from the address: the URL is wrong, or the hub or the
  path to it is down.

In either case the agent keeps retrying on its own, so it attaches once the cause is fixed.

What happened is in the agent's own local log:

- Linux/WSL: `journalctl --user -u jake-agent -n 20`, or the rolling log under the agent's per-user
  data directory.
- Windows: `Get-Content "$env:LOCALAPPDATA\jake\agent.log" -Tail 20`.

From the hub side, `jake status` on main-host shows whether this agent is attached and whether
commands are moving.

## Update

An installed agent is brought to the live build without anyone at the machine. Every deployment of
the hub publishes the agent build of the same commit to its download address, and the hub orders
each attached agent that runs another build onto it:

- When an agent says hello, or at a later ping while it is still behind, the hub compares the version
  it announced with the one its release carries. An installed build that differs, on a machine the
  build has a binary for, is ordered to update once nothing a caller started is running on it: no
  command and no transfer. An open ssh stream does not hold it back and drops with the restart, as it
  does when the hub restarts.
- The order is one short command that hands the update to a runner of its own and ends at once, so
  the call never hangs on the agent it replaces. On Windows the runner is the one-shot scheduled task
  `JakeUpdate`, on Linux the transient user unit `jake-update`. Task Scheduler and the user's service
  manager own it, so it outlives the agent it stops. On Windows the runner and the install script it
  runs are handed to PowerShell as inline text, never as a `.ps1` file, so a PC whose policy blocks
  script files is updated all the same.
- The runner waits until `version.txt` at the download address names the build it was ordered onto, which
  the deployment publishes right after the hub comes up, and gives up after ten minutes. It then
  downloads the install script and runs it in its update mode (`--update` on Linux, `-Update` on
  Windows), the same install as by hand without a question asked: it stops
  the agent, replaces the binary, refreshes the registrations, starts it again and keeps the config.
  It does nothing on a machine where no installed agent runs, as with the desktop app's built-in one.
- In update mode the install keeps the previous binary until the new one reaches the hub. Where the
  new build reports no connection within thirty seconds of starting, it puts the previous binary
  back, starts it again and ends with an error, so the machine stays attached. On Windows a build
  whose start is held up is given up to two minutes to start before those thirty seconds count.
- Whatever else fails once the agent is stopped, a download, the swap of the binary, a registration
  or putting the previous binary back, the install still leaves a binary in place and starts the
  agent again, on Windows the guard with it, before it ends with an error. The runner starts them
  once more where the install itself ended in failure.
- What the runner did is written to `update.log` beside the agent's own log. The hub writes a line to
  its log for each order and how the command ended, and does not order the same agent again for an
  hour.
- The hub's `JAKE_AGENT_UPDATE=off` turns the orders off (hub.env.example).

`jake --version` prints the build an installed binary is. On Windows pipe its output, as in
`& jake.exe --version | Out-String`: `jake.exe` opens no console, and PowerShell waits for such a
program and takes what it prints only when its output goes into a pipe, not when it is merely
assigned to a variable. The binary takes no other command: `jake
status` is the hub's console on main-host, and the agent's binary refuses it.

To update by hand, run the one-liner again, or run the install script again from a new build folder.
It stops the running agent, replaces the binary, refreshes its registration, and starts it again. The
config is left as it is.

## Uninstall

Run the uninstall script for the platform:

- Linux/WSL: `./uninstall.sh` (or from the install location). It stops and disables the user service,
  tells the hub the agent has left, removes the unit, and deletes the install layout. Run from a WSL
  shell, it also stops and removes the Windows task that keeps the distribution running, with the
  hold's executable where the task had one.
- Windows: `& "$env:LOCALAPPDATA\Programs\jake\uninstall.ps1"`. It stops the programs, tells the hub
  the agent has left, removes all three anchors for both run modes, and deletes the install folder.

Telling the hub is what makes it list this agent as departed rather than disconnected. If the hub
cannot be reached at that moment, the uninstall still completes and says the hub was not told.

The config file (`agent.env`) and the log are kept by default, so a reinstall reuses the URL and
secret. To leave nothing behind, pass `--remove-config` (Linux) or `-RemoveConfig` (Windows):

```powershell
& "$env:LOCALAPPDATA\Programs\jake\uninstall.ps1" -RemoveConfig
```

## Removing it from the hub side

There is also a remote counterpart to the uninstaller, sent from main-host rather than run on this
machine: `jake leave --yes`. It tells the attached agent to uninstall itself — the binary, the
config, the log, and every autostart registration — stop whatever keeps it running, and detach for
good. On WSL the agent cannot reach Windows from its service, so the task that keeps the distribution
running stays registered until the uninstall script is run from a WSL shell or the task is deleted in
Task Scheduler. It is irreversible and keeps no config, so the console refuses it without `--yes`, and it works
only while the agent is attached.
