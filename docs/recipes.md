# jake shell recipes

The shell is what the agent runs (docs/architecture.md, "What crosses the tunnel"). Most of what BMO
needs from the machine is a command sent through `jake exec` from main-host; these are the commands
for the common cases. Moving a whole file is the exception — `jake upload <local> <remote>` and
`jake download <remote> <local>` carry it end to end over the tunnel's own frames
(docs/architecture.md, "Moving files"), so the base64-through-a-command trick below is for a binary
that a command produces inline, not for transferring a file that already exists.

`jake-hub exec` takes the same flags as `jake exec` and runs every exec recipe here without bun.

The recipes are written for a hub with one agent attached. With several attached, every one of them
takes `--agent <name>` to say which machine it runs on; `jake status` lists the names.

## How a binary result crosses

- The console prints a command's stdout as text, so a binary result — a PNG, an inline blob — is
  printed as base64 by the remote command and decoded on main-host with `base64 -d`.
- The output cap (`JAKE_EXEC_MAX_OUTPUT_BYTES`, 8 MiB by default) counts the base64 text, which is a
  third larger than the bytes. A result past it is cut off and the command is stopped. The reason
  goes to stderr, never into the base64 on stdout, and the exit code is non-zero, so a truncated file
  is never mistaken for a whole one.
- Quote the whole remote command in single quotes on the main-host side, so the local shell leaves
  its `$` alone.

## Screenshot of the desktop

- Runs in PowerShell in 하스's logged-on session, which is where the agent itself runs, so it sees
  the real desktop.
- It marks the process DPI-aware first, so a scaled display is captured at its physical resolution
  rather than its scaled-down logical size.
- The rectangle is the virtual screen, spanning every monitor. For one monitor, take
  `[System.Windows.Forms.Screen]::AllScreens`, pick the entry by `DeviceName` or `Primary`, and use its
  `Bounds` instead.

```sh
jake exec 'Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Namespace W -Name Dpi -MemberDefinition "[DllImport(""user32.dll"")] public static extern bool SetProcessDPIAware();"
[void][W.Dpi]::SetProcessDPIAware()
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
[Convert]::ToBase64String($ms.ToArray())' | base64 -d > shot.png
```

## HTTP request from inside 하스's network

- `curl.exe` ships with Windows 10 and later. Call it as `curl.exe`, because a bare `curl` in
  Windows PowerShell is an alias of `Invoke-WebRequest`.
- `-i` prints the status line and headers before the body, `-L` follows redirects, and `-X`, `-H`,
  and `--data` set the method, headers, and body as usual.

```sh
jake exec 'curl.exe -sS -i -L http://192.0.2.1/'
```

- A binary body is written to a temp file first and printed as base64. Piping a native program's
  bytes through the PowerShell pipeline re-encodes them, so the file is the safe route.

```sh
jake exec '$f = "$env:TEMP\jake-get.bin"
curl.exe -sS -L -o $f http://192.0.2.10/file.zip
[Convert]::ToBase64String([IO.File]::ReadAllBytes($f)); Remove-Item $f' | base64 -d > file.zip
```

- The same request from WSL uses the distribution's own `curl`, and its pipe carries bytes intact.

```sh
jake exec --shell wsl 'curl -sS -L http://192.0.2.10/file.zip | base64 -w0' | base64 -d > file.zip
```

## Edge

- Open a page in 하스's own Edge, on his desktop: `jake exec 'Start-Process msedge https://example.com'`.
- Read a page's rendered DOM or photograph it with headless Edge. A throwaway `--user-data-dir` keeps
  it off 하스's own profile, and headless Edge shows no window.

```sh
jake exec '$edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
& $edge --headless --disable-gpu --user-data-dir="$env:TEMP\jake-edge" --dump-dom https://example.com | Out-String'

jake exec '$edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
$f = "$env:TEMP\jake-page.png"
& $edge --headless --disable-gpu --user-data-dir="$env:TEMP\jake-edge" --window-size=1280,800 --screenshot=$f https://example.com | Out-Null
[Convert]::ToBase64String([IO.File]::ReadAllBytes($f)); Remove-Item $f' | base64 -d > page.png
```

## ssh, and herdr, to a machine behind the tunnel

- ssh reaches the agent's machine through a byte stream (docs/architecture.md, "Carrying a byte
  stream"): the hub executable's connect mode is the `ProxyCommand`, so ssh talks to the machine's
  own sshd as if it had dialled it. The machine needs an sshd, its port among the agent's
  `JAKE_STREAM_PORTS`, and the main-host key in the account's authorized keys; docs/install.md has
  the steps.
- One `Host` block per machine in `~/.ssh/config` on main-host, named after the agent. `HostName`
  is only the name ssh records the host key under, since the connection never dials it; `User` is
  the account on that machine.

```sshconfig
Host jake_wsl
  HostName jake_wsl
  User ahas
  ProxyCommand ~/.local/share/jake-hub/deploy/bin/jake-hub connect jake_wsl 22
  ServerAliveInterval 30
```

- The proxy path is the hub's deployed binary (docs/deploy.md, step 7), so ssh runs the live commit.
- Then `ssh jake_wsl` logs in, and `scp` and `rsync -e ssh` work the same way.
- herdr's saved SSH machines ride on the same entry, because herdr reaches a remote machine through
  ssh. `herdr machine add jake_wsl` prepares the herdr server on the machine and saves it, and
  `herdr --machine jake_wsl agent list` answers from it.
- A refusal is written to standard error by the connect mode before ssh gives up: an agent that is
  not attached, a port the agent does not offer, or a port nothing answers on. When the agent's
  connection drops, ssh sees its connection close; once the agent has redialled, the next `ssh` gets
  through.
