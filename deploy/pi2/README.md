# pi-2 production deployment

Production is reconciled with `origin/main` in two ways:

- GitHub sends an HMAC-authenticated push event to `https://bill.fearnot.tw/github-webhook`.
- `split-bill-sync.timer` polls GitHub roughly every three minutes, covering missed webhooks and transient failures.

Both paths run `split-bill-deploy.sh` and share one lock. A commit is marked as deployed only after all of these succeed:

1. `origin/main` is fetched and the checkout is fast-forwarded without discarding local tracked changes.
2. Docker builds an immutable SHA-tagged image; `npm run verify` runs inside the build.
3. A consistent SQLite and uploads snapshot is created.
4. The candidate starts against a disposable snapshot copy and passes `/healthz`, SQLite integrity, foreign-key, and receipt checks.
5. A maintenance gate blocks traffic, the current container stops, and a second cutover snapshot captures every committed write.
6. The live container starts behind the gate and passes the same checks before traffic resumes.

If the live checks fail, the script stages and validates the prior data before restoring both the prior image and cutover snapshot. Durable state in `runtime/.deploy-state` lets the next timer recover an interrupted cutover after a signal or reboot. The successful SHA is stored in `runtime/.deployed-commit`; a failed build is retried because repository HEAD is not treated as deployment state. Disk space is checked before each run, and only the latest eight deployment snapshot sets are retained.

## Migrating the existing pi-2 production service

Copy `compose.yaml` to `/home/fearnot/projects/split-bill-docker/compose.yaml`, and copy the three unit files to `~/.config/systemd/user/`. Keep these files outside Git and mode `0600`:

- `/home/fearnot/projects/split-bill/.env`
- `/home/fearnot/.config/split-bill-webhook/env`
- `/home/fearnot/projects/split-bill/codex/auth.json`, when used

The webhook secret must be a random value shared only between the GitHub hook and the webhook environment file. Never commit it. Then enable the services:

```bash
chmod 0600 /home/fearnot/projects/split-bill/.env
chmod 0700 /home/fearnot/projects/split-bill/codex
find /home/fearnot/projects/split-bill/codex -type f -exec chmod 0600 {} +
docker stop split-bill-webhook
docker rm split-bill-webhook
systemctl --user daemon-reload
systemctl --user enable --now split-bill-webhook.service split-bill-sync.timer
```

The updater intentionally requires the existing production `data.db` and rollback image. Bootstrap a brand-new empty host separately, verify it, and only then enable automatic reconciliation.

The sync service deliberately uses `UMask=0077`. The production Dockerfile normalizes read and directory-traversal permissions after copying the application, then runs a build-time read check as the unprivileged `node` runtime user. Candidate startup waits on the image `HEALTHCHECK`; failures record only container state and the last 200 log lines before cleanup, without dumping environment variables.

The installed `compose.yaml` must remain byte-for-byte identical to the reviewed repository template. Application commits deploy automatically; a commit that changes production Compose or systemd assets requires reinstalling those assets before reconciliation resumes.

The router/firewall exposes only ports 80 and 443. Nginx proxies the exact `/github-webhook` path to `192.168.1.120:3200`; port 3200 is not exposed directly to the internet.

## Verification

```bash
systemctl --user status split-bill-webhook.service split-bill-sync.timer
systemctl --user start split-bill-sync.service
journalctl --user -u split-bill-sync.service -n 100 --no-pager
cat /home/fearnot/projects/split-bill-docker/runtime/.deployed-commit
docker inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' split-bill
curl -fsS https://bill.fearnot.tw/healthz
curl -fsSI https://bill.fearnot.tw/healthz | grep -i '^x-app-revision:'
```

The marker, image revision label, Pi checkout, and GitHub `main` SHA must match. A second sync run should log `already running healthy commit` without rebuilding.
