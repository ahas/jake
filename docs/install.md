# Installing the jake agent

- jake is a **bmo agent proxy**: the proxy through which BMO manages one of 하스's own machines. It
  opens a tunnel outward to the hub on main-host, and once attached the hub side runs shell commands
  and moves files on that machine.
- It installs on either kind of host — a Windows box, where it runs PowerShell and WSL commands, or a
  Linux/WSL box, where it runs a Linux shell.
- This guide is how 하스 installs, updates, and removes it on his own machine.
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
example config, the install and uninstall scripts, and this guide.

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
  brings it back, and every minute both rewrite the three autostart anchors: a logon scheduled task, a
  registry Run value, and a Startup-folder shortcut. A deleted anchor is restored within a minute as
  long as either program is alive.
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

Run the one-liner again, or run the install script again from a new build folder. It stops the
running agent, replaces the binary, refreshes its registration, and starts it again. The config is
left as it is.

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
