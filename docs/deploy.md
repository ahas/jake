# Deploying the hub

The hub is the main-host side of the tunnel: the agent dials into it, and 비모 and the console drive
the agent through it. This is the procedure that makes it run permanently on main-host and reachable
from 하스's network as `jake.example.org`. The commands are given in the order they must run.

Nothing here is run as part of building the hub. Opening the firewall port, creating the DNS record,
writing the NPM proxy host and reloading nginx, and enabling the service all change live
infrastructure, so they belong to a deployment turn, not to a build. Run them from main-host unless a step says otherwise.

The committed pieces this procedure installs: the systemd user unit `jake-hub.service`, the
config example `hub.env.example`, the nginx template `deploy/jake.example.org.conf`, the testbed's declaration
`testbed.toml`, and this document.

## 1. The config file

The hub reads a single file under the data directory, outside the git tree. Copy the example, fill in
the two secrets, and lock it down.

```sh
mkdir -p ~/.local/share/jake
cp ~/repos/ahas/jake/hub.env.example ~/.local/share/jake/hub.env
# Generate two independent secrets and put them in the file:
openssl rand -hex 32   # -> JAKE_SECRET        (the agent must present the same value)
openssl rand -hex 32   # -> JAKE_CONTROL_TOKEN (the console and 비모 present this one)
"$EDITOR" ~/.local/share/jake/hub.env
chmod 600 ~/.local/share/jake/hub.env
```

`JAKE_AGENT_KEY` is optional: set it (`openssl rand -hex 32`) to admit agents by a credential of their own name
(docs/architecture.md), and give the same value to whoever mints those credentials. `JAKE_CONTROL_KEY` is
optional as well: set it to another `openssl rand -hex 32`, never the agent key's value, to let the control API take a
credential scoped to named agents (docs/architecture.md, 「Configuration and secrets」); `jake-hub credential
<agent>...` then prints one, and a tool given it in `JAKE_CONTROL_CREDENTIAL` reaches those agents alone. `JAKE_REVERSE_TARGETS` is
optional too: the `host:port` targets, comma separated, a stream back from an agent may reach (docs/architecture.md,
「Carrying a byte stream back」); left out, none may. `JAKE_SECRET` and
`JAKE_CONTROL_TOKEN` are required and have no default; leave the others commented to
take their defaults. The hub listens on `JAKE_HUB_PORT` (8790 by default) bound to `JAKE_HUB_HOST`
(0.0.0.0, so it accepts the connection NPM forwards). If you change the port here, change it in the
nginx template in step 5 too — the two must agree. Record the same `JAKE_SECRET` in the agent's
`agent.env` on 하스's box so the agent authenticates.

## 2. The systemd user service

The hub is the Rust crate under `hub/`, and the unit runs its release binary from the deploy tree,
`~/.local/share/jake-hub/deploy/bin/jake-hub`. Nothing runs from the checkout or its build directory:
the binary is built by BMO's testbed when it deploys a commit (step 8), so the first deployment both
builds the hub and links the unit. Deploy once from main-host, then enable the unit and turn on
lingering so it runs across a reboot without an interactive login.

```sh
env -u CLAUDE_PID bmo-testbed deploy jake
systemctl --user enable --now jake-hub
loginctl enable-linger "$USER"
```

The deployment links `~/.config/systemd/user/jake-hub.service` to the unit file in the deploy tree,
restarts the hub and waits until it answers. The unit will not start until the config file from step 1
exists, which is what the `ConditionPathExists` guards. A restart runs the deployed commit again; only a
deployment changes what the hub runs.

The CLI the shell and other tools call, `jake-hub exec` among them, is the same binary. Link it onto the
PATH once, so it follows every deployment rather than keeping a copy of its own:

```sh
ln -sf ~/.local/share/jake-hub/deploy/bin/jake-hub ~/.local/bin/jake-hub
```

After the unit file itself changes, run `systemctl --user daemon-reload` once so systemd reads the
new start step; after that a restart is enough. Confirm it came up:

```sh
systemctl --user status jake-hub
```

## 3. The firewall opening

main-host runs ufw, which drops every inbound port it has no rule for. NPM reaches the hub from its
LXC at 192.168.0.101, so open the hub's port to that address alone; nothing else needs to reach it,
because every agent comes in through NPM.

```sh
sudo ufw allow from 192.168.0.101 to any port 8790 proto tcp comment 'jake hub via NPM'
```

Without this rule the hub answers on loopback but NPM's connection hangs, and a request to
`jake.example.org` times out rather than failing outright.

## 4. The DNS record

Add a CNAME `jake.example.org` -> `home.example.org`, DNS only (not proxied), in the `ahas.io` zone with the
Cloudflare API token.

```sh
curl -s -X POST \
  "https://api.cloudflare.com/client/v4/zones/5b25bef912499973b4df6b361dfd95b2/dns_records" \
  -H "Authorization: Bearer $(cat ~/.config/cloudflare/token)" \
  -H "Content-Type: application/json" \
  --data '{"type":"CNAME","name":"jake","content":"home.example.org","proxied":false,"ttl":1}'
```

## 5. The NPM proxy host

A proxy host is two things that must agree: a row in the `proxy_host` table of NPM's database, and the
generated nginx config. Write the row first, read back the id it was assigned, then write the config
under that id and reload nginx. All of this runs inside the NPM LXC (VMID 109) on vm-host, which has
no `sqlite3` binary — use the `sqlite3` module bundled with the NPM app.

Insert the row (forwarding to main-host on the hub's port, the wildcard certificate 76, websocket
upgrade on), and print the new id:

```sh
ssh mm 'pct exec 109 -- node -e '\''
const sqlite3 = require("/app/node_modules/sqlite3");
const db = new sqlite3.Database("/data/database.sqlite");
const now = new Date().toISOString().slice(0, 19).replace("T", " ");
db.run(
  `INSERT INTO proxy_host
     (created_on, modified_on, owner_user_id, is_deleted, domain_names, forward_host,
      forward_port, access_list_id, certificate_id, ssl_forced, caching_enabled, block_exploits,
      advanced_config, meta, allow_websocket_upgrade, http2_support, forward_scheme, enabled,
      locations, hsts_enabled, hsts_subdomains)
   VALUES (?,?,1,0,?,?,?,0,76,1,0,0,?,?,1,1,'http',1,'[]',0,0)`,
  [
    now, now,
    JSON.stringify(["jake.example.org"]),
    "192.0.2.8x", 8790,
    "client_max_body_size 0;\nproxy_buffering off;\nproxy_request_buffering off;\nproxy_read_timeout 3600s;\nproxy_send_timeout 3600s;",
    JSON.stringify({ letsencrypt_agree: false, dns_challenge: false, nginx_online: true, nginx_err: null }),
  ],
  function (err) {
    if (err) { console.error(err); process.exit(1); }
    console.log("proxy_host id:", this.lastID);
    db.close();
  },
);
'\'''
```

Take the printed id. Substitute it for `HOSTID` in the committed template and write the result to the
container as `<id>.conf`, then check and reload nginx:

```sh
ID=<the id printed above>
sed "s/HOSTID/$ID/g" ~/repos/ahas/jake/deploy/jake.example.org.conf \
  | ssh mm "pct exec 109 -- sh -c 'cat > /data/nginx/proxy_host/$ID.conf'"
ssh mm "pct exec 109 -- sh -c 'nginx -t && nginx -s reload'"
```

The port in the template must equal `JAKE_HUB_PORT` from step 1 and the port opened in step 3. The
certificate needs nothing new: 76 is the live `ahas.io, *.ahas.io` wildcard, and `jake.example.org` is
covered by it.

## 6. Verify

```sh
systemctl --user status jake-hub                 # active (running)
jake-hub up                                      # both ports answer as the hub does
curl -sI https://jake.example.org/                   # HTTP 401 — the hub answers, and wants the secret
curl -sI -H "Authorization: Bearer $(grep '^JAKE_SECRET=' ~/.local/share/jake/hub.env | cut -d= -f2)" \
  https://jake.example.org/                          # HTTP 426 — authorized, expecting a WS upgrade
bun ~/repos/ahas/jake/src/console/main.ts status   # every attached agent, one line each
```

`jake-hub up` reads `hub.env` the way the hub does and asks the running hub once: the agent server, at
`JAKE_HUB_HOST` (the loopback address where that is the unspecified address) and `JAKE_HUB_PORT`, with no
credential, which answers 401; and the control API's `/status` on `JAKE_CONTROL_PORT` with the control
credential, which answers 200. It exits 0 where both answer so and 1 otherwise, each time naming what each
port answered, and waits at most ten seconds on either port.

The agent server checks the secret before anything else, so a plain request reaching the hub returns
401, and the same request carrying the secret returns 426 because the server accepts only a WebSocket
upgrade. Either code is the proof the DNS -> router -> NPM -> hub path is whole; the 426 also proves
the secret in `hub.env` is the one the hub loaded. A 502 means NPM cannot reach the hub — recheck the
port and that the service is running — and a timeout means the firewall rule from step 3 is missing.
The console's `status` runs against the loopback control API, which is never exposed through NPM; it
is how you see, on main-host, which of 하스's agents have dialed in. The hub holds every agent at
once, one per agent name, so a second machine's agent appears beside the first rather than in its
place.

## 7. ssh to a machine behind the tunnel

The `ProxyCommand` that carries ssh to an agent's machine is the hub's deployed binary, run in its
connect mode: `~/.local/share/jake-hub/deploy/bin/jake-hub connect <agent> [port]`. It is the deploy
tree's path, so ssh always runs the live commit and no build or sweep of a checkout can take it away.
The link at `~/.local/bin/jake-hub` from step 2 is the same file for use outside ssh, where `jake-hub
exec` runs a command on a machine without bun. Both read the control port and token from the same
`hub.env`.

The machine side — an SSH server, the agent's `JAKE_STREAM_PORTS`, and main-host's key in the
account's authorized keys — is in docs/install.md, and the `~/.ssh/config` block, with herdr's saved
machines on top of it, in docs/recipes.md. With both in place:

```sh
bun ~/repos/ahas/jake/src/console/main.ts status   # the agent lists stream:22 among its capabilities
ssh jake_wsl true && echo reached                   # the login runs over the tunnel
```

A hub restart drops every agent's connection, and every ssh session riding one ends with it; ssh
connects again once the agents have redialled, a few seconds later.

## 8. Putting a commit live

A commit goes live through BMO's testbed. Its hosted deploy tool deploys the repository by the name
`jake`, the one this repository's `testbed.toml` declares, from the checkout the machine's registry of
checkouts lists for it: `checkouts.toml` under the testbed's data directory, which lists this checkout.
The declaration says the rest:

- The deploy root is `~/.local/share/jake-hub`. It holds the deploy tree `deploy`, the releases, the
  deployment record `deployed.json` with its log, the progress record and the backups. The data root is
  `~/.local/share/jake`, the hub's own data directory, which each deployment's backup carries, the
  agent's log left out.
- `jake-hub.service` marks itself as the deployment's one watched service (`X-BMO-Deploy=bot` in its
  `[Install]` section, which systemd ignores). Each deployment links the unit to its file in the deploy
  tree, restarts the hub and waits until `bin/jake-hub up`, run from the release, answers 0, so the
  hub serves on both its ports before the deployment ends `live`.
- The hub runs the release: the unit's binary is the deploy tree's `bin/jake-hub`, which the testbed
  builds from the commit it deploys. The commit the record names live is exactly what the hub runs,
  whatever the checkout holds meanwhile.
- A rollback flips the deploy tree back to the previous release and restarts the hub, which then runs
  that release's binary.
- A jake job's close waits on this deployment: it reads the records under the deploy root and ends
  `live` once a deployment of its commit does.
