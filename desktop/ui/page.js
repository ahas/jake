// The bundled page: draws the app's status and its frameless window's top bar, asks for the server's
// address while the app names none or the tray changes it, and asks the app's commands.

const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
const element = (id) => document.getElementById(id);

const ACTION_WORDS = { pairAgain: "다시 연결", lookAgain: "다시 확인" };
const REFRESH_MS = 1000;
// Opened from the tray's 서버 변경, the page changes the server the app runs on.
const CHANGING = new URLSearchParams(location.search).get("server") === "change";
const CHANGE_HEADLINE = "서버 변경";
const CHANGE_DETAIL =
  "다른 서버로 변경하면 이 앱에 저장된 지금 서버의 연결 정보를 삭제하고 새 서버에서 앱 연결을 다시 합니다.";

function paragraphs(lines) {
  return lines.map((line) => {
    const paragraph = document.createElement("p");
    paragraph.textContent = line;
    return paragraph;
  });
}

// The field takes the keyboard once, as the form first shows.
let focused = false;

function render(view) {
  const asking = CHANGING || view.asksServer;
  element("frame-title").textContent = view.title;
  element("mark").className = `mark ${CHANGING ? "idle" : view.tone}`;
  element("headline").textContent = CHANGING ? CHANGE_HEADLINE : view.headline;
  element("detail").replaceChildren(...paragraphs(CHANGING ? [CHANGE_DETAIL] : view.detail));
  const code = element("code");
  code.hidden = asking || !view.code;
  code.textContent = view.code ?? "";
  const consoleDetail = element("console-detail");
  consoleDetail.hidden = asking || !view.consoleDetail;
  consoleDetail.textContent = view.consoleDetail ?? "";
  element("status-actions").hidden = asking;
  element("server").hidden = !asking;
  element("server-cancel").hidden = !CHANGING;
  if (asking && !focused) {
    focused = true;
    element("server-address").focus();
  }
  const retry = element("retry");
  retry.hidden = !view.action;
  retry.textContent = view.action ? ACTION_WORDS[view.action] : "";
  retry.className = view.action ? "primary" : "";
  element("console").textContent = view.consoleDetail ? "다시 시도" : "콘솔 열기";
  element("console").className = view.action ? "" : "primary";
}

async function refresh() {
  try {
    render(await invoke("status"));
  } catch {
    // The page is shown before the app's state is managed; the next refresh draws it.
  }
}

// A button shows its spinner until the command it asked has answered.
function wire(id, command) {
  const button = element(id);
  button.addEventListener("click", async () => {
    if (button.getAttribute("aria-busy") === "true") return;
    button.setAttribute("aria-busy", "true");
    try {
      await invoke(command);
    } finally {
      button.removeAttribute("aria-busy");
      await refresh();
    }
  });
}

wire("console", "console");
wire("retry", "retry");
wire("server-cancel", "console");

// The server's address: the app reads it, asks whether it is a BMO console and writes it, then starts
// again on it, so the form stays busy until then; a refusal is said under the field.
function showRefusal(reason) {
  const error = element("server-error");
  error.hidden = !reason;
  error.textContent = reason ?? "";
  element("server-address").setAttribute("aria-invalid", reason ? "true" : "false");
}

element("server").addEventListener("submit", async (event) => {
  event.preventDefault();
  const save = element("server-save");
  const field = element("server-address");
  if (save.getAttribute("aria-busy") === "true") return;
  save.setAttribute("aria-busy", "true");
  field.readOnly = true;
  showRefusal(null);
  let restarting = false;
  try {
    restarting = await invoke("set_console", { address: field.value });
    // The server the app runs on already: back to its console.
    if (!restarting) await invoke("console");
  } catch (reason) {
    showRefusal(typeof reason === "string" ? reason : String(reason));
    field.focus();
  } finally {
    if (!restarting) {
      save.removeAttribute("aria-busy");
      field.readOnly = false;
    }
  }
});

// The window's controls, drawn where the app says the page draws them and inset room left otherwise
// (docs/desktop.md, 「The window's frame」); the address the app runs on fills the form a change opens.
async function frame() {
  try {
    const { windowControls, consoleUrl } = await invoke("settings");
    element("controls").hidden = windowControls !== "console";
    element("frame").classList.toggle("inset", windowControls === "inset");
    const field = element("server-address");
    if (CHANGING && consoleUrl && field.value === "") {
      field.value = consoleUrl;
    }
  } catch {
    // The page is drawn before the app's state is managed; the next try draws it.
    setTimeout(frame, REFRESH_MS);
  }
}

element("minimize").addEventListener("click", () => invoke("plugin:window|minimize"));
element("maximize").addEventListener("click", () => invoke("plugin:window|toggle_maximize"));
element("close").addEventListener("click", () => invoke("plugin:window|close"));
frame();
refresh();
setInterval(refresh, REFRESH_MS);
