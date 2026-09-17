# Deploying the hub

The hub is the main-host side of the tunnel: the agent dials into it, and 비모 and the console drive
the agent through it. This is the procedure that makes it run permanently on main-host and reachable
from 하스's network as `jake.example.org`. The commands are given in the order they must run.

Nothing here is run as part of building the hub. Creating the DNS record, writing the NPM proxy host
and reloading nginx, and enabling the service all change live infrastructure, so they belong to a
deployment turn, not to a build. Run them from main-host unless a step says otherwise.

The four committed pieces this procedure installs: the systemd user unit `jake-hub.service`, the
config example `hub.env.example`, the nginx template `deploy/jake.example.org.conf`, and this document.

## 1. The config file

The hub reads a single file under the data directory, outside the git tree. Copy the example, fill in
the two secrets, and lock it down.

```sh
mkdir -p ~/.local/share/jake
cp ~/repos/ahas/infra/jake/hub.env.example ~/.local/share/jake/hub.env
# Generate two independent secrets and put them in the file:
openssl rand -hex 32   # -> JAKE_SECRET        (the agent must present the same value)
openssl rand -hex 32   # -> JAKE_CONTROL_TOKEN (the console and 비모 present this one)
"$EDITOR" ~/.local/share/jake/hub.env
chmod 600 ~/.local/share/jake/hub.env
```

`JAKE_SECRET` and `JAKE_CONTROL_TOKEN` are required and have no default; leave the others commented to
take their defaults. The hub listens on `JAKE_HUB_PORT` (8790 by default) bound to `JAKE_HUB_HOST`
(0.0.0.0, so it accepts the connection NPM forwards). If you change the port here, change it in the
nginx template in step 4 too — the two must agree. Record the same `JAKE_SECRET` in the agent's
`agent.env` on 하스's box so the agent authenticates.

## 2. The systemd user service

Link the unit into the user unit directory, enable it, and turn on lingering so it runs across a
reboot without an interactive login.

```sh
mkdir -p ~/.config/systemd/user
ln -sf ~/repos/ahas/infra/jake/jake-hub.service ~/.config/systemd/user/jake-hub.service
systemctl --user daemon-reload
systemctl --user enable --now jake-hub
loginctl enable-linger "$USER"
```

The unit will not start until the config file from step 1 exists — that is what the
`ConditionPathExists` guards. Confirm it came up:

```sh
systemctl --user status jake-hub
```

## 3. The DNS record

Add a CNAME `jake.example.org` -> `home.example.org`, DNS only (not proxied), in the `ahas.io` zone with the
Cloudflare API token.

```sh
curl -s -X POST \
  "https://api.cloudflare.com/client/v4/zones/5b25bef912499973b4df6b361dfd95b2/dns_records" \
  -H "Authorization: Bearer $(cat ~/.config/cloudflare/token)" \
  -H "Content-Type: application/json" \
  --data '{"type":"CNAME","name":"jake","content":"home.example.org","proxied":false,"ttl":1}'
```

## 4. The NPM proxy host

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
   VALUES (?,?,1,0,?,?,?,0,76,1,0,0,?,?,1,1,"http",1,"[]",0,0)`,
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
sed "s/HOSTID/$ID/g" ~/repos/ahas/infra/jake/deploy/jake.example.org.conf \
  | ssh mm "pct exec 109 -- sh -c 'cat > /data/nginx/proxy_host/$ID.conf'"
ssh mm "pct exec 109 -- sh -c 'nginx -t && nginx -s reload'"
```

The port in the template must equal `JAKE_HUB_PORT` from step 1. The certificate needs nothing new: 76
is the live `ahas.io, *.ahas.io` wildcard, and `jake.example.org` is covered by it.

## 5. Verify

```sh
systemctl --user status jake-hub                 # active (running)
curl -sI https://jake.example.org/                   # HTTP 426 — the hub answers, expecting a WS upgrade
bun ~/repos/ahas/infra/jake/src/console/main.ts status   # whether the agent is attached
```

A plain request to `jake.example.org` reaching the hub returns 426 (the agent server accepts only a
WebSocket upgrade); that 426 is the proof the DNS -> router -> NPM -> hub path is whole. A 502 instead
means NPM cannot reach the hub — recheck the port and that the service is running. The console's
`status` runs against the loopback control API, which is never exposed through NPM; it is how you see,
on main-host, whether 하스's agent has dialed in.
