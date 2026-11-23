// The bundled page: draws the app's status and its frameless window's top bar, and asks the app's commands.

const invoke = (command) => window.__TAURI_INTERNALS__.invoke(command);
const element = (id) => document.getElementById(id);

const ACTION_WORDS = { pairAgain: "다시 연결", lookAgain: "다시 확인" };
const REFRESH_MS = 1000;

function render(view) {
  element("frame-title").textContent = view.title;
  element("mark").className = `mark ${view.tone}`;
  element("headline").textContent = view.headline;
  element("detail").replaceChildren(
    ...view.detail.map((line) => {
      const paragraph = document.createElement("p");
      paragraph.textContent = line;
      return paragraph;
    }),
  );
  const code = element("code");
  code.hidden = !view.code;
  code.textContent = view.code ?? "";
  const consoleDetail = element("console-detail");
  consoleDetail.hidden = !view.consoleDetail;
  consoleDetail.textContent = view.consoleDetail ?? "";
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

// The window's controls, drawn where the app says the page draws them and inset room left otherwise
// (docs/desktop.md, 「The window's frame」).
async function frame() {
  try {
    const { windowControls } = await invoke("settings");
    element("controls").hidden = windowControls !== "console";
    element("frame").classList.toggle("inset", windowControls === "inset");
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
