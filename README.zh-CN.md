[English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | **简体中文**

# jake

jake 是一个 **bmo agent proxy**:BMO 管理其所有者远程机器时所经由的代理。它运行在所有者的某台机器上(Windows
机器或 Linux/WSL 机器),主动向外连接到 main-host 上的 hub,这样 BMO 就能触达那些从它自己的网络无法向内连接的
机器。BMO 通过这一条隧道执行 shell 命令,并双向传输文件。hub 可以同时持有任意数量机器的代理,每个代理以自己的
代理名称区分,每条命令都会指明要发往哪台机器。

- **运行模式**:在 Windows 主机上使用 PowerShell 和 WSL,在 Linux 或 WSL 主机上使用 Linux shell。
- **文件传输**:通过隧道自身的帧进行上传和下载,文件无需 scp 即可穿过隧道。
- **一行安装**:基础地址为 `ai.example.org/bmo/jake/`。
  - Linux/WSL: `curl -fsSL https://ai.example.org/bmo/jake/install.sh | bash`
  - Windows: `powershell -c "irm https://ai.example.org/bmo/jake/install.ps1 | iex"`
- **桌面应用**:把 BMO 的 Web 控制台做成一个独立应用,并在其中内置代理;加入方式是在控制台中批准,而不是在安装时
  输入密钥。

各部分如何配合见 docs/architecture.md,隧道帧见 docs/protocol.md,安装见 docs/install.md,桌面应用见
docs/desktop.md,如何部署 hub 见 docs/deploy.md,shell 用法示例见 docs/recipes.md。

hub 由智能体按照索引的 INSTALL.md(`bmo install`,https://bmo.ahas.io/install.md)安装到 BMO 机器上。
