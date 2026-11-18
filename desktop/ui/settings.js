// The bundled settings page: a switch a setting, each written and taking effect the moment it is turned.

const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
const element = (id) => document.getElementById(id);

const WORDS = {
  keepControlWhileLocked: {
    label: "잠금 중 원격 제어 유지",
    hint: "끄면 PC가 잠겨 있는 동안 에이전트 연결을 끊습니다.",
  },
  closeToTray: {
    label: "창을 닫으면 트레이로 이동",
    hint: "끄면 창을 닫을 때 앱을 종료합니다.",
  },
  startAtSignIn: { label: "로그인할 때 시작" },
  startInTray: {
    label: "트레이에서 시작",
    hint: "로그인할 때 시작하면 창을 열지 않습니다.",
  },
  keepAwake: {
    label: "절전 모드 방지",
    hint: "에이전트 실행 중에는 PC가 절전 모드로 전환되지 않습니다.",
  },
};
const FAILED = "변경하지 못했습니다.";
const REFRESH_MS = 1000;

const rows = new Map();
let shownKeys = "";
let busy = false;

// One row a switch, made once and kept, so a refresh never takes focus from the switch it redraws.
function row(key) {
  if (rows.has(key)) return rows.get(key);
  const words = WORDS[key] ?? { label: key };
  const item = document.createElement("li");
  item.className = "setting";
  const text = document.createElement("div");
  text.className = "setting-text";
  const label = document.createElement("label");
  label.htmlFor = `switch-${key}`;
  label.textContent = words.label;
  text.append(label);
  if (words.hint) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = words.hint;
    text.append(hint);
  }
  const error = document.createElement("div");
  error.className = "error";
  error.hidden = true;
  text.append(error);
  const button = document.createElement("button");
  button.type = "button";
  button.id = `switch-${key}`;
  button.className = "switch";
  button.setAttribute("role", "switch");
  button.addEventListener("click", () => turn(key));
  item.append(text, button);
  const made = { item, button, error };
  rows.set(key, made);
  return made;
}

function render(view) {
  const keys = view.switches.map((entry) => entry.switch).join(" ");
  if (keys !== shownKeys) {
    element("switches").replaceChildren(...view.switches.map((entry) => row(entry.switch).item));
    shownKeys = keys;
  }
  for (const entry of view.switches) {
    const { button } = row(entry.switch);
    button.setAttribute("aria-checked", String(entry.on));
    button.disabled = Boolean(view.unreadable);
  }
  element("unreadable").hidden = !view.unreadable;
  element("unreadable-reason").textContent = view.unreadable ?? "";
}

function showError(error, reason) {
  const lead = document.createElement("p");
  lead.textContent = FAILED;
  const detail = document.createElement("p");
  detail.className = "machine";
  detail.textContent = String(reason);
  error.replaceChildren(lead, detail);
  error.hidden = false;
}

async function refresh() {
  if (busy) return;
  try {
    render(await invoke("settings"));
  } catch {
    // The page can be drawn before the app's state is managed; the next refresh draws it.
  }
}

// The switch shows its spinner until the app has written the setting and acted on it.
async function turn(key) {
  if (busy) return;
  const { button, error } = row(key);
  busy = true;
  button.setAttribute("aria-busy", "true");
  error.hidden = true;
  try {
    const on = button.getAttribute("aria-checked") !== "true";
    render(await invoke("change_setting", { setting: key, on }));
  } catch (reason) {
    showError(error, reason);
  } finally {
    button.removeAttribute("aria-busy");
    busy = false;
    await refresh();
  }
}

// Esc and Back leave the settings: nothing is ever held unsaved, so leaving asks nothing.
const close = () => invoke("close_settings");
document.addEventListener("keydown", (event) => {
  const back = event.key === "BrowserBack" || (event.altKey && event.key === "ArrowLeft");
  if (event.key === "Escape" || back) {
    event.preventDefault();
    close();
  }
});
// The mouse's back button.
document.addEventListener("mouseup", (event) => {
  if (event.button === 3) {
    event.preventDefault();
    close();
  }
});

refresh();
setInterval(refresh, REFRESH_MS);
