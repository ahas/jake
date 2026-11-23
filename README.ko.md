[English](README.md) | **한국어** | [日本語](README.ja.md) | [简体中文](README.zh-CN.md)

# jake

jake는 **bmo agent proxy**입니다. BMO가 소유자의 원격 머신을 관리할 때 거치는 프록시입니다. 소유자의 머신 중
하나(Windows 머신이나 Linux/WSL 머신)에서 실행되며, main-host에 있는 허브로 바깥 방향 연결을 맺습니다. 그래서
BMO는 자기 네트워크에서 안쪽으로 접속할 수 없는 머신에도 닿을 수 있습니다. BMO는 이 터널 하나를 통해 셸 명령을
실행하고 파일을 양방향으로 옮깁니다. 허브는 여러 머신의 에이전트를 동시에 붙잡고 있으며, 각 에이전트는 고유한
에이전트 이름으로 구분되고, 모든 명령은 보낼 머신을 지정합니다.

- **실행 모드**: Windows 호스트에서는 PowerShell과 WSL, Linux 또는 WSL 호스트에서는 Linux 셸을 씁니다.
- **파일 전송**: 터널 자체의 프레임으로 업로드와 다운로드를 하므로, scp 없이 파일이 터널을 건너갑니다.
- **한 줄 설치**: 직접 운영하는 허브의 다운로드 주소, 곧 그 배포가 게시하는 `JAKE_AGENT_DOWNLOAD_URL`에서 설치합니다(docs/install.md).
  - Linux/WSL: `curl -fsSL <다운로드 주소>/install.sh | bash`
  - Windows: `powershell -c "irm <다운로드 주소>/install.ps1 | iex"`
- **데스크톱 앱**: BMO의 웹 콘솔을 별도 앱으로 만든 것으로, 에이전트를 앱 안에 품고 있습니다. 설치할 때 비밀값을
  입력하는 대신 콘솔에서 승인하는 방식으로 합류합니다.

구성 요소가 어떻게 맞물리는지는 docs/architecture.md, 터널 프레임은 docs/protocol.md, 설치는 docs/install.md,
데스크톱 앱은 docs/desktop.md, 허브를 띄우는 방법은 docs/deploy.md, 셸 활용 예시는 docs/recipes.md를 참고하십시오.

허브는 에이전트가 인덱스의 INSTALL.md(`bmo install`, https://bmo.ahas.io/install.md)로 BMO 머신에 설치합니다.
