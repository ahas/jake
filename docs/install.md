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
  the two different machines, or one of them alone: on a machine where an installed agent of the same
  name runs, the app keeps its own agent off.
- No administrator rights are needed. Everything runs in his own user account.

## One-line install

The install scripts and the binaries are served under `ai.example.org/bmo/jake/`, so one command
installs from a clean machine.

- **Linux or WSL** — from a shell:

  ```sh
  curl -fsSL https://ai.example.org/bmo/jake/install.sh | bash
  ```

- **Windows** — from a PowerShell window:

  ```powershell
  powershell -c "irm https://ai.example.org/bmo/jake/install.ps1 | iex"
  ```

The script fetches the binary for the machine's platform (`ai.example.org/bmo/jake/jake` on Linux,
`ai.example.org/bmo/jake/jake.exe` on Windows), writes the config, registers the agent so it stays
running, and starts it. What it needs is below.

## What it asks

The install needs three values, and nothing more:

- **Hub URL** — the hub to attach to. An empty answer takes the default, `wss://jake.example.org`.
- **Shared secret** — the secret the hub also holds. It is not shown while typed.
- **Agent name** — this agent's name, which is how the hub and the console tell this machine from
  the others. The hub holds one connection per name: give every machine its own, because a second
  install under a name already attached replaces the first.

Run interactively, the script asks for the three; the secret and the name have no default and must
be given. On a re-run the values already in `agent.env` are offered instead, and an empty answer
keeps them. To install without prompts, pass them as arguments (the hub URL may be left out, and
the default is used):

- Linux/WSL: `curl -fsSL https://ai.example.org/bmo/jake/install.sh | bash -s -- --hub-url wss://jake.example.org --secret '<shared secret>' --agent-name '<this agent name>'`
- Windows: run `install.ps1` with `-HubUrl wss://jake.example.org -Secret '<shared secret>' -AgentName '<this agent name>'`.

The shared secret is written only to that machine's config file (`agent.env`). It is in neither the
repository nor the executable.

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
  not that user is logged in, and restarts on its own after a crash.
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
- The scheduled tasks have no run-time limit and run on battery, so Task Scheduler never ends the
  pair on its own after a few days.
- All three anchors belong to **this user account**. They register without administrator rights, and
  so they fire when **this account logs on**, not at boot itself.
- If both programs die together and the anchors are wiped as well, jake comes back at **this
  account's next logon**. On a machine without auto-logon, boot and logon are different events; while
  the machine sits powered on with nobody logged in, jake stays down for that stretch.
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
   curl -fsSL https://ai.example.org/bmo/jake/install.sh | bash -s -- --ssh-key 'ssh-ed25519 AAAA... ahas@main-host'
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
the hub publishes the agent build of the same commit to `ai.example.org/bmo/jake/`, and the hub orders
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
- The runner waits until `ai.example.org/bmo/jake/version.txt` names the build it was ordered onto, which
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

To update by hand, run the one-liner again, or run the install script again from a new build folder.
It stops the running agent, replaces the binary, refreshes its registration, and starts it again. The
config is left as it is.

## Uninstall

Run the uninstall script for the platform:

- Linux/WSL: `./uninstall.sh` (or from the install location). It stops and disables the user service,
  tells the hub the agent has left, removes the unit, and deletes the install layout.
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
good. It is irreversible and keeps no config, so the console refuses it without `--yes`, and it works
only while the agent is attached.
