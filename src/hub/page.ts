// The hub's read-only status page. It is the console's web surface: a single self-contained page
// the hub serves over its loopback control API, showing whether the agent is attached and the
// frames crossing the tunnel. It carries no control the CLI does not already have.
//
// A browser navigating to a page cannot attach an Authorization header, so the page route is the one
// unauthenticated corner of the control API, and the token is embedded in the page it returns so the
// page's own calls to /status and /events carry it. This is safe because the control API binds to
// loopback alone: anyone who can load the page is already on the machine and could read the token
// from the hub's config file just as easily. The page makes only read requests.

/** Render the status page, embedding the control token so the page can call the API on its own. */
export function renderConsolePage(token: string): string {
  const embeddedToken = JSON.stringify(token);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>jake console</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px 16px; background: #0f1115; color: #d6d9df;
    font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  h1 { font-size: 16px; margin: 0 0 4px; color: #f2f4f8; }
  .sub { color: #7a808c; margin-bottom: 20px; }
  .card { background: #161a21; border: 1px solid #262b34; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  .state { display: flex; align-items: center; gap: 10px; font-size: 15px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: #4b515c; flex: none; }
  .dot.on { background: #4ec97a; box-shadow: 0 0 8px #4ec97a88; }
  .dot.off { background: #d16060; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 14px 0 0; }
  dt { color: #7a808c; }
  dd { margin: 0; word-break: break-word; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; color: #7a808c; font-weight: normal; padding: 4px 8px; border-bottom: 1px solid #262b34; position: sticky; top: 0; background: #161a21; }
  td { padding: 3px 8px; border-bottom: 1px solid #1d222a; vertical-align: top; }
  .feed { max-height: 55vh; overflow: auto; }
  .in { color: #6fb3ff; }
  .out { color: #e0a86a; }
  .summary { color: #9aa0ac; white-space: pre-wrap; }
  .empty { color: #565c68; padding: 8px; }
</style>
</head>
<body>
<h1>jake console</h1>
<div class="sub" id="hubrun">read-only view of the tunnel</div>

<div class="card">
  <div class="state"><span class="dot" id="dot"></span><span id="stateText">connecting…</span></div>
  <dl id="detail" hidden>
    <dt>agent</dt><dd id="agentName">—</dd>
    <dt>version</dt><dd id="agentVersion">—</dd>
    <dt>connected for</dt><dd id="uptime">—</dd>
    <dt>capabilities</dt><dd id="caps">—</dd>
    <dt>in-flight</dt><dd id="inflight">—</dd>
    <dt>pending calls</dt><dd id="pending">—</dd>
  </dl>
</div>

<div class="card">
  <div class="sub" style="margin:0 0 10px">traffic</div>
  <div class="feed">
    <table>
      <thead><tr><th>time</th><th>dir</th><th>type</th><th>summary</th></tr></thead>
      <tbody id="feed"><tr><td colspan="4" class="empty">waiting for frames…</td></tr></tbody>
    </table>
  </div>
</div>

<script>
const TOKEN = ${embeddedToken};
const AUTH = { headers: { authorization: "Bearer " + TOKEN } };

function fmtDuration(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const parts = [];
  if (h) parts.push(h + "h");
  if (h || m) parts.push(m + "m");
  parts.push(s + "s");
  return parts.join(" ");
}

async function poll() {
  try {
    const res = await fetch("/status", AUTH);
    const s = await res.json();
    const dot = document.getElementById("dot");
    const detail = document.getElementById("detail");
    document.getElementById("hubrun").textContent = "hub " + s.run;
    if (s.attached && s.agent) {
      dot.className = "dot on";
      document.getElementById("stateText").textContent = "attached";
      detail.hidden = false;
      document.getElementById("agentName").textContent = s.agent.name;
      document.getElementById("agentVersion").textContent = "v" + s.agent.agentVersion;
      document.getElementById("uptime").textContent = fmtDuration(Date.now() - s.agent.connectedAt);
      document.getElementById("caps").textContent = s.agent.capabilities.length ? s.agent.capabilities.join(", ") : "(none)";
      document.getElementById("inflight").textContent = s.inFlight.length ? s.inFlight.join(", ") : "(none)";
      document.getElementById("pending").textContent = s.pendingCalls;
    } else {
      dot.className = "dot off";
      document.getElementById("stateText").textContent = "detached — no agent connected";
      detail.hidden = true;
    }
  } catch (e) {
    document.getElementById("dot").className = "dot";
    document.getElementById("stateText").textContent = "cannot reach the hub";
  }
}

function addRow(entry) {
  const feed = document.getElementById("feed");
  const empty = feed.querySelector(".empty");
  if (empty) empty.parentElement.remove();
  const tr = document.createElement("tr");
  const time = new Date(entry.at).toISOString().slice(11, 23);
  const dir = entry.dir === "in" ? "<-" : "->";
  tr.innerHTML =
    '<td>' + time + '</td>' +
    '<td class="' + entry.dir + '">' + dir + '</td>' +
    '<td>' + entry.type + '</td>' +
    '<td class="summary"></td>';
  tr.lastChild.textContent = JSON.stringify(entry.summary);
  feed.appendChild(tr);
  while (feed.childElementCount > 300) feed.removeChild(feed.firstChild);
  tr.scrollIntoView({ block: "nearest" });
}

async function tail() {
  for (;;) {
    try {
      const res = await fetch("/events?after=0", AUTH);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\\n\\n")) !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (block === "" || block.startsWith(":")) continue;
          let event = "message", data = "";
          for (const line of block.split("\\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (event === "traffic" && data) addRow(JSON.parse(data));
        }
      }
    } catch (e) {
      // the stream dropped; fall through to reconnect
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

poll();
setInterval(poll, 2000);
tail();
</script>
</body>
</html>`;
}
