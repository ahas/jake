# Installing the jake agent

- jake is the agent installed on 하스's Windows machine. It opens a tunnel outward to the hub on
  main-host, and once attached the hub side runs PowerShell and WSL commands on that machine.
- This guide is how 하스 installs, updates, and removes it on his own machine.
- No administrator rights are needed. Run everything from a PowerShell window in his own account.

## What you receive

One folder produced by the build, containing:

- `jake.exe` — the program. Started with no argument it is the agent, which holds the tunnel and runs
  commands; started with the guard flag it is the small guard that watches the agent and brings it
  back. One file does both.
- `agent.env.example` — an example of the config file.
- `install.ps1` · `uninstall.ps1` — the install and uninstall scripts.
- `INSTALL.md` — this guide.

Unpack the folder anywhere and run the installer from inside it.

## Install

Open a PowerShell window inside the received folder and run:

```powershell
.\install.ps1
```

If script execution is blocked because this is the first script opened, allow it for that window
only and run it again:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\install.ps1
```

To install in one go without prompts, pass the values as arguments:

```powershell
.\install.ps1 -HubUrl wss://jake.example.org -Secret '<shared secret>' -AgentName '<this agent name>'
```

- The default install location is `%LOCALAPPDATA%\Programs\jake`; add `-InstallDir <path>` to put it
  elsewhere.
- Running it again over an existing install is safe: anchors are not stacked, the running programs
  are stopped and come back up as the new build, and values edited by hand in `agent.env` are kept.

## What it asks

Without arguments it asks three things, and these three are all it needs:

- **Hub URL** — the hub to attach to, e.g. `wss://jake.example.org`.
- **Shared secret** — the secret the hub also holds. It is not shown while typed.
- **Agent name** — this agent's name. The hub accepts one agent of this name.

The shared secret is written only to that machine's config file (`agent.env`). It is in neither the
repository nor the executable.

## Checking it worked

The installer starts the programs, watches briefly whether the agent reaches the hub, and reports:

- **Green "connected to the hub"** — attached. Done.
- **Yellow notice** — not attached yet. Either the secret or name is wrong (rejected), or the URL is
  wrong or the hub is down (unreachable). The agent keeps retrying on its own, so it attaches once
  the cause is fixed.

What happened is in the log:

```powershell
Get-Content "$env:LOCALAPPDATA\jake\agent.log" -Tail 20
```

From the hub side, `jake status` on main-host shows whether this agent is attached and whether
commands are moving.

## Update

Receive the new build folder and run the installer again from inside it:

```powershell
.\install.ps1
```

It stops the running programs, replaces the executable, re-registers the anchors, and starts them
again. The config is left as it is.

## Uninstall

Run the uninstall script inside the install folder:

```powershell
& "$env:LOCALAPPDATA\Programs\jake\uninstall.ps1"
```

- It stops the programs, removes all three anchors for both run modes, and deletes the install
  folder.
- The config file (`agent.env`) and the log are kept, so a reinstall reuses the URL and secret.
- Add `-RemoveConfig` to leave nothing behind:

```powershell
& "$env:LOCALAPPDATA\Programs\jake\uninstall.ps1" -RemoveConfig
```

## How far it comes back on its own

- The two programs watch each other. When one dies or hangs the other brings it back, and every
  minute (one tick) both rewrite the three autostart anchors — a logon scheduled task, a registry Run
  value, and a Startup-folder shortcut. A deleted anchor is restored within a minute as long as
  either program is alive.
- All three anchors belong to **this user account**. They register without administrator rights, and
  so they fire when **this account logs on**, not at boot itself.
- If both programs die together and the anchors are wiped as well, jake comes back at **this
  account's next logon**.
- On a machine without auto-logon, boot and logon are different events; while the machine sits
  powered on with nobody logged in, jake stays down for that whole stretch.
- **With auto-logon on**, boot is logon, so jake comes back on its own after a reset or reboot with no
  one touching it. On a machine that resets often, auto-logon makes recovery certain.
- Starting at boot before logon, or running while nobody is logged on, needs an administrator
  account, and the install stays without administrator rights, so neither is used.
