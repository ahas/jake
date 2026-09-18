# jake shell recipes

The agent's only capability is the shell (docs/architecture.md, "Only a shell"). Everything else is a
command sent through `jake exec` from main-host. These are the commands for the common cases.

## How a binary result crosses

- The console prints a command's stdout as text, so a binary result — a PNG, a downloaded file — is
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
jake exec 'curl.exe -sS -i -L http://192.168.0.1/'
```

- A binary body is written to a temp file first and printed as base64. Piping a native program's
  bytes through the PowerShell pipeline re-encodes them, so the file is the safe route.

```sh
jake exec '$f = "$env:TEMP\jake-get.bin"
curl.exe -sS -L -o $f http://192.168.0.10/file.zip
[Convert]::ToBase64String([IO.File]::ReadAllBytes($f)); Remove-Item $f' | base64 -d > file.zip
```

- The same request from WSL uses the distribution's own `curl`, and its pipe carries bytes intact.

```sh
jake exec --shell wsl 'curl -sS -L http://192.168.0.10/file.zip | base64 -w0' | base64 -d > file.zip
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
