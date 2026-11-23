// The all-in-one's bundled page (docs/all-in-one.md, 「The first run」): draws the screen of the first run the
// app holds, sends the person's answers, and drives the frameless window's top bar.

const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
const element = (id) => document.getElementById(id);
const REFRESH_MS = 1000;

const SCREENS = {
  welcome: () => ({
    tone: "idle",
    headline: "이 컴퓨터에 BMO 설치",
    detail: [
      "BMO 개인용 구성(콘솔, 기억, 코딩 에이전트, 채팅 서비스 하나, 문서·노트·캘린더·파일·메일·원격 데스크톱)을 이 컴퓨터에 설치하고 실행합니다.",
      "~/bmo 에 저장소를, ~/.local/share 아래에 설정과 서비스를 둡니다. 메모리 16 GB, 디스크 60 GB 이상이 필요하고, 모든 서비스를 소스에서 빌드하므로 처음 한 번은 오래 걸립니다.",
      "동의하기 전에는 아무것도 바뀌지 않습니다.",
    ],
    chat: true,
    primary: ["동의하고 설치", () => invoke("aio_consent", { chat: chosenChat() })],
  }),
  checking: () => ({ tone: "working", headline: "이 컴퓨터 확인 중", detail: [] }),
  refused: (screen) => ({ tone: "attention", headline: "이 컴퓨터에는 설치할 수 없습니다", detail: screen.reasons }),
  accept: (screen) => ({
    tone: "attention",
    headline: "확인이 필요합니다",
    detail: screen.warnings,
    primary: ["그래도 계속", () => invoke("aio_accept")],
  }),
  preparing: () => ({ tone: "working", headline: "설치 프로그램 준비 중", detail: ["저장소를 받고 설치 프로그램을 빌드합니다."] }),
  planning: () => ({ tone: "working", headline: "설치 계획 확인 중", detail: [] }),
  prerequisites: (screen) => ({
    tone: "attention",
    headline: "먼저 필요한 프로그램이 있습니다",
    detail: screen.missing.map((missing) => `${missing.program}: ${missing.detail}`),
    primary: ["시스템 패키지 설치", () => invoke("aio_prerequisites")],
    secondary: ["다시 확인", () => invoke("aio_retry")],
  }),
  inputs: (screen) => ({
    tone: "idle",
    headline: "몇 가지 정보가 필요합니다",
    detail: [],
    inputs: screen.asked,
    primary: ["저장하고 계속", keepInputs],
  }),
  installing: () => ({ tone: "working", headline: "설치 중", detail: ["서비스마다 빌드하고 배포합니다. 끝날 때까지 시간이 걸립니다."] }),
  failed: (screen) => ({
    tone: "attention",
    headline: "설치가 멈췄습니다",
    detail: [screen.step, screen.detail, screen.next].filter(Boolean),
    primary: ["다시 시도", () => invoke("aio_retry")],
  }),
  starting: () => ({ tone: "working", headline: "BMO 시작 중", detail: [] }),
  ready: (screen) => ({ tone: "good", headline: "BMO가 실행 중입니다", detail: [screen.console] }),
};

function chosenChat() {
  return document.querySelector('input[name="chat"]:checked')?.value ?? "telegram";
}

function paragraphs(lines) {
  return lines.map((line) => {
    const paragraph = document.createElement("p");
    paragraph.textContent = line;
    return paragraph;
  });
}

// The fields of the values asked, drawn once for each set of names so a value being typed stays.
let drawnInputs = "";

function drawInputs(asked) {
  const form = element("inputs");
  const names = asked.map((field) => field.input).join(",");
  form.hidden = asked.length === 0;
  if (names === drawnInputs) return;
  drawnInputs = names;
  form.replaceChildren(
    ...asked.flatMap((field) => {
      const label = document.createElement("label");
      label.htmlFor = `input-${field.input}`;
      label.textContent = field.input;
      const input = document.createElement("input");
      input.id = `input-${field.input}`;
      input.dataset.input = field.input;
      input.type = field.secret ? "password" : "text";
      input.autocomplete = "off";
      input.spellcheck = false;
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent = field.detail;
      return [label, input, hint];
    }),
  );
}

async function keepInputs() {
  for (const input of element("inputs").querySelectorAll("input")) {
    await invoke("aio_input", { input: input.dataset.input, value: input.value });
  }
  drawnInputs = "";
  await invoke("aio_inputs_done");
}

function button(id, action, busy) {
  const node = element(id);
  node.hidden = !action;
  node.disabled = busy;
  node.textContent = action ? action[0] : "";
  node.onclick = action
    ? async () => {
        if (node.getAttribute("aria-busy") === "true") return;
        node.setAttribute("aria-busy", "true");
        showError(null);
        try {
          await action[1]();
        } catch (reason) {
          showError(typeof reason === "string" ? reason : String(reason));
        } finally {
          node.removeAttribute("aria-busy");
          await refresh();
        }
      }
    : null;
}

function showError(reason) {
  const error = element("error");
  error.hidden = !reason;
  error.textContent = reason ?? "";
}

function render(view) {
  const drawn = (SCREENS[view.screen.screen] ?? SCREENS.checking)(view.screen);
  element("mark").className = `mark ${view.busy ? "working" : drawn.tone}`;
  element("headline").textContent = drawn.headline;
  element("detail").replaceChildren(...paragraphs(drawn.detail));
  element("chat").hidden = !drawn.chat;
  drawInputs(drawn.inputs ?? []);
  button("primary", drawn.primary, view.busy);
  button("secondary", drawn.secondary, view.busy);
  const lines = element("lines");
  lines.hidden = view.lines.length === 0 || view.screen.screen === "welcome";
  lines.textContent = view.lines.join("\n");
}

async function refresh() {
  try {
    render(await invoke("aio_view"));
  } catch {
    // The page is shown before the app's state is managed; the next refresh draws it.
  }
}

async function frame() {
  try {
    const { windowControls } = await invoke("settings");
    element("controls").hidden = windowControls !== "console";
    element("frame").classList.toggle("inset", windowControls === "inset");
  } catch {
    setTimeout(frame, REFRESH_MS);
  }
}

element("minimize").addEventListener("click", () => invoke("plugin:window|minimize"));
element("maximize").addEventListener("click", () => invoke("plugin:window|toggle_maximize"));
element("close").addEventListener("click", () => invoke("plugin:window|close"));
frame();
refresh();
setInterval(refresh, REFRESH_MS);
