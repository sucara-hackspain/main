# Preview on the VPS

`vps-623af2a2.vps.ovh.net` (OVH, Ubuntu) already runs `caddy-docker-proxy` on ports 80/443, configuring Caddy from the
labels of containers on the `previews` network. This stack joins it as `https://hackspain.eighteen.sh` (an A record to
the VPS's IPv4): the Control Center at `/`, the engine's 112 webhook at `/phone`.

The repo is private and the VPS has no key for it, so the tree is copied from a laptop:

```sh
rsync -az --delete --exclude node_modules --exclude runs --exclude .env --exclude dist --exclude .git --exclude /gabriel/memory . ubuntu@vps-623af2a2.vps.ovh.net:/opt/hackspain/repo/
scp gabriel/.env ubuntu@vps-623af2a2.vps.ovh.net:/opt/hackspain/gabriel.env
ssh ubuntu@vps-623af2a2.vps.ovh.net 'cd /opt/hackspain/repo && docker compose -f deploy/preview/docker-compose.yml up -d --build'
```

The engine runs a 1200-tick night at 2 s a tick, then starts another; runs land in `/opt/hackspain/runs`. To point the
112 voice workflow at it: `pnpm hr:phone https://hackspain.eighteen.sh` (a publish, run by hand).
