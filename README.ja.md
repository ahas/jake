[English](README.md) | [한국어](README.ko.md) | **日本語** | [简体中文](README.zh-CN.md)

# jake

jake は **bmo agent proxy** です。BMO がオーナーのリモートマシンを管理するときに経由するプロキシです。オーナーの
マシンのいずれか(Windows マシンまたは Linux/WSL マシン)で動作し、main-host 上のハブへ外向きに接続します。これに
より BMO は、自分のネットワークから内向きには接続できないマシンにも到達できます。BMO はこの 1 本のトンネルを通じて
シェルコマンドを実行し、ファイルを双方向に転送します。ハブは任意の数のマシンのエージェントを同時に保持し、各
エージェントは固有のエージェント名で識別され、すべてのコマンドは送り先のマシンを指定します。

- **実行モード**:Windows ホストでは PowerShell と WSL、Linux または WSL ホストでは Linux シェル。
- **ファイル転送**:トンネル自身のフレームでアップロードとダウンロードを行うため、scp なしでファイルがトンネルを
  通ります。
- **ワンラインインストール**:ベース `ai.example.org/bmo/jake/` から。
  - Linux/WSL: `curl -fsSL https://ai.example.org/bmo/jake/install.sh | bash`
  - Windows: `powershell -c "irm https://ai.example.org/bmo/jake/install.ps1 | iex"`
- **デスクトップアプリ**:BMO の Web コンソールを独立したアプリにしたもので、エージェントを内蔵しています。
  インストール時に秘密の値を入力するのではなく、コンソールで承認することで参加します。

各部品の組み合わせ方は docs/architecture.md、トンネルのフレームは docs/protocol.md、インストールは
docs/install.md、デスクトップアプリは docs/desktop.md、ハブの立ち上げは docs/deploy.md、シェルのレシピは
docs/recipes.md を参照してください。

ハブは、エージェントがインデックスの INSTALL.md（`bmo install`、https://bmo.ahas.io/install.md）で BMO のマシンに
インストールします。
