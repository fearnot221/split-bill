#!/usr/bin/env bash
set -Eeuo pipefail

export PATH=/usr/local/bin:/usr/bin:/bin
umask 077

readonly repo=/home/fearnot/projects/split-bill
readonly branch=main
readonly remote=origin
readonly expected_remote=https://github.com/fearnot221/split-bill.git
readonly compose_dir=/home/fearnot/projects/split-bill-docker
readonly compose_file=$compose_dir/compose.yaml
readonly runtime_dir=$compose_dir/runtime
readonly env_file=$repo/.env
readonly image_repository=split-bill-app
readonly container_name=split-bill
readonly local_health_url=http://192.168.1.120:3100/healthz
readonly public_health_url=https://bill.fearnot.tw/healthz
readonly marker_file=$runtime_dir/.deployed-commit
readonly image_marker_file=$runtime_dir/.deployed-image
readonly maintenance_file=$runtime_dir/.maintenance
readonly state_file=$runtime_dir/.deploy-state
readonly lock_file=$compose_dir/.deploy.lock
readonly backup_root=$runtime_dir/deploy-backups
readonly keep_backup_sets=8

candidate_container=
target=
deployed=
old_image=
snapshot=
snapshot_rel=
cutover_active=false
rollback_ready=false
recovery_in_progress=false

log() {
  printf '%s %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*"
}

die() {
  log "ERROR: $*" >&2
  exit 1
}

http_ok() {
  local url=$1
  local body
  body=$(curl --fail --silent --show-error --max-time 5 "$url" 2>/dev/null) || return 1
  [[ "$body" == "ok" ]]
}

compose=(
  docker compose
  --project-name split-bill-docker
  --project-directory "$compose_dir"
  --file "$compose_file"
)

stop_and_confirm() {
  if ! docker inspect "$container_name" >/dev/null 2>&1; then
    return 0
  fi
  if [[ "$(docker inspect --format '{{.State.Running}}' "$container_name" 2>/dev/null || true)" == "true" ]]; then
    if ! docker stop --time 20 "$container_name" >/dev/null; then
      log "could not stop $container_name" >&2
      return 1
    fi
  fi
  if [[ "$(docker inspect --format '{{.State.Running}}' "$container_name" 2>/dev/null || true)" != "false" ]]; then
    log "$container_name may still be running" >&2
    return 1
  fi
}

wait_for_live_health() {
  local deadline=$((SECONDS + 60))
  while (( SECONDS < deadline )); do
    if http_ok "$local_health_url"; then
      return 0
    fi
    sleep 2
  done
  return 1
}

start_image() {
  local image=$1
  SPLIT_BILL_IMAGE="$image" "${compose[@]}" \
    up --detach --no-deps --force-recreate split-bill
}

write_state() {
  local phase=$1
  local state_snapshot=${2:-}
  local temporary="$state_file.tmp.$$"
  if ! printf '%s\n' \
    'version=1' \
    "phase=$phase" \
    "target=$target" \
    "previous_commit=$deployed" \
    "old_image=$old_image" \
    "snapshot_rel=$state_snapshot" > "$temporary"; then
    rm -f "$temporary"
    return 1
  fi
  if ! chmod 600 "$temporary" || ! mv -f "$temporary" "$state_file"; then
    rm -f "$temporary"
    return 1
  fi
  sync -f "$runtime_dir"
}

write_target_markers() {
  local image=$1
  local marker_tmp="$marker_file.tmp.$$"
  local image_tmp="$image_marker_file.tmp.$$"
  if ! printf '%s\n' "$target" > "$marker_tmp" \
    || ! printf '%s\n' "$image" > "$image_tmp" \
    || ! chmod 600 "$marker_tmp" "$image_tmp" \
    || ! mv -f "$marker_tmp" "$marker_file" \
    || ! mv -f "$image_tmp" "$image_marker_file"; then
    rm -f "$marker_tmp" "$image_tmp"
    return 1
  fi
  sync -f "$runtime_dir"
}

reset_deployment_markers() {
  local marker_tmp="$marker_file.restore.$$"
  local image_tmp="$image_marker_file.restore.$$"
  if [[ -z "$deployed" ]]; then
    rm -f "$marker_file" "$image_marker_file"
    return
  fi
  if ! printf '%s\n' "$deployed" > "$marker_tmp" \
    || ! printf '%s\n' "$old_image" > "$image_tmp" \
    || ! chmod 600 "$marker_tmp" "$image_tmp" \
    || ! mv -f "$marker_tmp" "$marker_file" \
    || ! mv -f "$image_tmp" "$image_marker_file"; then
    rm -f "$marker_tmp" "$image_tmp"
    return 1
  fi
}

finish_recovery() {
  if ! reset_deployment_markers; then
    log "CRITICAL: could not restore deployment markers" >&2
    return 1
  fi
  if ! rm -f "$state_file"; then
    log "CRITICAL: could not clear deployment recovery state" >&2
    return 1
  fi
  if ! sync -f "$runtime_dir"; then
    log "CRITICAL: could not persist cleared deployment recovery state" >&2
    return 1
  fi
  if ! rm -f "$maintenance_file"; then
    log "CRITICAL: could not remove the maintenance gate" >&2
    return 1
  fi
  cutover_active=false
  rollback_ready=false
}

resume_previous_without_restore() {
  log "restarting unchanged image $old_image"
  if ! start_image "$old_image"; then
    log "CRITICAL: could not restart the previous image" >&2
    return 1
  fi
  if ! wait_for_live_health; then
    log "CRITICAL: previous image did not become healthy" >&2
    return 1
  fi
  if ! finish_recovery; then
    return 1
  fi
}

restore_previous() {
  log "restoring production data and image $old_image"
  if ! stop_and_confirm; then
    log "CRITICAL: refusing to restore while the app may still be running" >&2
    return 1
  fi

  local restore_id="${target:0:12}-$$"
  if ! docker run --rm --user 0:0 \
    --env "SNAPSHOT_REL=$snapshot_rel" \
    --env "RESTORE_ID=$restore_id" \
    --env "RESTORE_UID=$(id -u)" \
    --env "RESTORE_GID=$(id -g)" \
    --volume "$runtime_dir:/data" \
    --entrypoint /bin/sh "$old_image" -ec '
      snapshot="/data/$SNAPSHOT_REL"
      stage="/data/.restore-$RESTORE_ID"
      test -f "$snapshot/data.db"
      test -d "$snapshot/uploads"
      rm -rf "$stage"
      mkdir -m 700 "$stage" "$stage/uploads"
      cp "$snapshot/data.db" "$stage/data.db"
      cp -a "$snapshot/uploads/." "$stage/uploads/"
      chown -R "$RESTORE_UID:$RESTORE_GID" "$stage"
      chmod 600 "$stage/data.db"
      chmod 700 "$stage/uploads"
    '; then
    log "CRITICAL: could not stage the rollback snapshot" >&2
    return 1
  fi

  if ! docker run --rm --user "$(id -u):$(id -g)" \
    --env "CHECK_DB=/data/.restore-$restore_id/data.db" \
    --env "CHECK_UPLOADS=/data/.restore-$restore_id/uploads" \
    --volume "$runtime_dir:/data" \
    --entrypoint node "$old_image" -e '
      const fs = require("fs");
      const path = require("path");
      const Database = require("better-sqlite3");
      const db = new Database(process.env.CHECK_DB, { readonly: true, fileMustExist: true });
      const integrity = db.pragma("integrity_check", { simple: true });
      const foreignKeys = db.pragma("foreign_key_check");
      const columns = db.prepare("PRAGMA table_info(expenses)").all();
      const receipts = columns.some((column) => column.name === "receipt")
        ? db.prepare("SELECT receipt FROM expenses WHERE receipt IS NOT NULL").all()
        : [];
      db.close();
      if (integrity !== "ok" || foreignKeys.length !== 0) process.exit(1);
      for (const { receipt } of receipts) {
        if (typeof receipt !== "string" || path.basename(receipt) !== receipt) process.exit(1);
        if (!fs.statSync(path.join(process.env.CHECK_UPLOADS, receipt)).isFile()) process.exit(1);
      }
    '; then
    log "CRITICAL: staged rollback data failed integrity checks" >&2
    return 1
  fi

  if ! docker run --rm --user 0:0 \
    --env "RESTORE_ID=$restore_id" \
    --env "RESTORE_UID=$(id -u)" \
    --env "RESTORE_GID=$(id -g)" \
    --volume "$runtime_dir:/data" \
    --entrypoint /bin/sh "$old_image" -ec '
      stage="/data/.restore-$RESTORE_ID"
      previous="/data/.restore-previous-$RESTORE_ID"
      rm -rf "$previous"
      mkdir -m 700 "$previous"
      complete=false
      rollback_done=false
      undo_swap() {
        if [ "$complete" = true ] || [ "$rollback_done" = true ]; then return; fi
        rollback_done=true
        rm -f /data/data.db /data/data.db-wal /data/data.db-shm
        rm -rf /data/uploads
        for name in data.db data.db-wal data.db-shm uploads; do
          if [ -e "$previous/$name" ]; then mv "$previous/$name" "/data/$name"; fi
        done
      }
      on_hup() { undo_swap; exit 129; }
      on_int() { undo_swap; exit 130; }
      on_term() { undo_swap; exit 143; }
      trap undo_swap EXIT
      trap on_hup HUP
      trap on_int INT
      trap on_term TERM
      for name in data.db data.db-wal data.db-shm uploads; do
        if [ -e "/data/$name" ]; then mv "/data/$name" "$previous/$name"; fi
      done
      mv "$stage/data.db" /data/data.db
      mv "$stage/uploads" /data/uploads
      chown -R "$RESTORE_UID:$RESTORE_GID" /data/data.db /data/uploads
      chmod 600 /data/data.db
      chmod 700 /data/uploads
      complete=true
      trap - EXIT HUP INT TERM
      rm -rf "$previous" "$stage"
    '; then
    log "CRITICAL: atomic rollback data swap failed" >&2
    return 1
  fi

  if ! start_image "$old_image"; then
    log "CRITICAL: rollback image could not be started" >&2
    return 1
  fi
  if ! wait_for_live_health; then
    log "CRITICAL: rollback image did not become healthy" >&2
    return 1
  fi
  if ! finish_recovery; then
    return 1
  fi
  log "rollback is healthy"
}

complete_committed_deployment() {
  local already_running=${1:-false}
  local image="$image_repository:$target"
  local revision running_image
  revision=$(docker image inspect --format \
    '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image" 2>/dev/null || true)
  if [[ "$revision" != "$target" ]]; then
    log "CRITICAL: committed candidate image is unavailable or has the wrong revision" >&2
    return 1
  fi
  if [[ "$already_running" != true ]] && ! start_image "$image"; then
    log "CRITICAL: could not restart the committed candidate" >&2
    return 1
  fi
  if ! wait_for_live_health; then
    log "CRITICAL: committed candidate did not become healthy" >&2
    return 1
  fi
  revision=$(docker inspect --format \
    '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$container_name" 2>/dev/null || true)
  running_image=$(docker inspect --format '{{.Config.Image}}' "$container_name" 2>/dev/null || true)
  if [[ "$revision" != "$target" || "$running_image" != "$image" ]]; then
    log "CRITICAL: running container does not match the committed candidate" >&2
    return 1
  fi
  if ! write_target_markers "$image"; then
    log "CRITICAL: could not persist committed deployment markers" >&2
    return 1
  fi
  if ! rm -f "$maintenance_file"; then
    log "CRITICAL: could not remove the maintenance gate" >&2
    return 1
  fi
  cutover_active=false
  rollback_ready=false
  if ! rm -f "$state_file" || ! sync -f "$runtime_dir"; then
    log "CRITICAL: app is live but committed recovery state could not be cleared" >&2
    return 1
  fi
}

fail_with_rollback() {
  local reason=$1
  recovery_in_progress=true
  if restore_previous; then
    die "$reason; previous version restored"
  fi
  die "$reason; CRITICAL rollback failure, app remains gated or stopped"
}

fail_before_data_change() {
  local reason=$1
  recovery_in_progress=true
  if resume_previous_without_restore; then
    die "$reason; previous version restarted with unchanged data"
  fi
  die "$reason; CRITICAL restart failure, app remains gated or stopped"
}

cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  if [[ -n "$candidate_container" ]] && command -v docker >/dev/null 2>&1; then
    if [[ $status -ne 0 ]]; then
      log "candidate container diagnostics:" >&2
      docker inspect --format \
        'status={{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} error={{json .State.Error}}' \
        "$candidate_container" >&2 || true
      docker logs --timestamps --tail 200 "$candidate_container" >&2 || true
    fi
    docker rm -f "$candidate_container" >/dev/null 2>&1 || true
  fi
  if [[ $status -ne 0 && "$cutover_active" == true && "$recovery_in_progress" != true ]]; then
    recovery_in_progress=true
    set +e
    log "deployment interrupted; starting automatic recovery"
    if [[ "$rollback_ready" == true ]]; then
      restore_previous
    else
      resume_previous_without_restore
    fi
  fi
  exit "$status"
}

prune_deploy_backups() {
  local entry path
  local -a entries=()
  [[ -d "$backup_root" ]] || return 0
  mapfile -t entries < <(find "$backup_root" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn)
  for ((index = keep_backup_sets; index < ${#entries[@]}; index += 1)); do
    entry=${entries[index]}
    path=${entry#* }
    if [[ "$path" == "$backup_root/"* ]]; then
      rm -rf -- "$path"
    fi
  done
}

prune_app_images() {
  local reference image_id
  local kept=0
  local -a references=()
  mapfile -t references < <(docker image ls "$image_repository" --format '{{.Repository}}:{{.Tag}}')
  for reference in "${references[@]}"; do
    [[ "$reference" =~ :[0-9a-f]{40}$ ]] || continue
    image_id=$(docker image inspect --format '{{.Id}}' "$reference" 2>/dev/null || true)
    if [[ "$reference" == "$image_repository:$target" || "$image_id" == "$old_image" ]]; then
      continue
    fi
    kept=$((kept + 1))
    if (( kept > 2 )); then
      docker image rm "$reference" >/dev/null 2>&1 || true
    fi
  done
}

check_free_space() {
  local available_kb data_kb required_kb
  available_kb=$(df -Pk "$runtime_dir" | awk 'NR == 2 { print $4 }')
  data_kb=$(du -sk "$runtime_dir/data.db" "$runtime_dir/uploads" | awk '{ total += $1 } END { print total + 0 }')
  required_kb=$((1024 * 1024 + data_kb * 4))
  [[ "$available_kb" =~ ^[0-9]+$ ]] || return 1
  if (( available_kb < required_kb )); then
    log "insufficient disk space: ${available_kb}KB available, ${required_kb}KB required" >&2
    return 1
  fi
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

for command in awk cmp cp curl df docker du find flock git install sort sync; do
  command -v "$command" >/dev/null 2>&1 || die "required command is missing: $command"
done

mkdir -p "$compose_dir" "$runtime_dir" "$backup_root"
exec 9>"$lock_file"
if ! flock -n 9; then
  log "another deployment is already running; this trigger is a no-op"
  exit 0
fi

[[ -d "$repo/.git" ]] || die "repository not found: $repo"
[[ -f "$compose_file" ]] || die "Compose file not found: $compose_file"
[[ -f "$repo/deploy/pi2/Dockerfile" ]] || die "Dockerfile not found in checkout"
[[ -f "$env_file" ]] || die "environment file not found: $env_file"
docker compose version >/dev/null 2>&1 || die "Docker Compose plugin is unavailable"

if [[ -f "$state_file" ]]; then
  state_version=
  state_phase=
  state_target=
  state_previous_commit=
  state_old_image=
  state_snapshot_rel=
  while IFS='=' read -r key value; do
    case "$key" in
      version) state_version=$value ;;
      phase) state_phase=$value ;;
      target) state_target=$value ;;
      previous_commit) state_previous_commit=$value ;;
      old_image) state_old_image=$value ;;
      snapshot_rel) state_snapshot_rel=$value ;;
    esac
  done < "$state_file"
  [[ "$state_version" == 1 ]] || die "unsupported deployment recovery state"
  [[ "$state_phase" == preparing || "$state_phase" == rollback-ready \
    || "$state_phase" == committed ]] \
    || die "invalid deployment recovery phase"
  [[ "$state_target" =~ ^[0-9a-f]{40}$ ]] || die "invalid recovery target"
  [[ -z "$state_previous_commit" || "$state_previous_commit" =~ ^[0-9a-f]{40}$ ]] \
    || die "invalid previous commit in recovery state"
  [[ "$state_old_image" =~ ^[A-Za-z0-9_./:@-]+$ ]] || die "invalid recovery image"
  docker image inspect "$state_old_image" >/dev/null 2>&1 \
    || die "recovery image is not available: $state_old_image"

  target=$state_target
  deployed=$state_previous_commit
  old_image=$state_old_image
  recovery_in_progress=true
  if [[ "$state_phase" == committed ]]; then
    cutover_active=false
    rollback_ready=false
    complete_committed_deployment \
      || die "automatic forward recovery failed; app remains gated or stopped"
  elif [[ "$state_phase" == rollback-ready ]]; then
    cutover_active=true
    [[ "$state_snapshot_rel" == deploy-backups/* && "$state_snapshot_rel" != *'..'* ]] \
      || die "invalid recovery snapshot path"
    snapshot_rel=$state_snapshot_rel
    snapshot="$runtime_dir/$snapshot_rel"
    [[ -f "$snapshot/data.db" && -d "$snapshot/uploads" ]] \
      || die "recovery snapshot is incomplete"
    rollback_ready=true
    restore_previous || die "automatic rollback recovery failed; app remains gated or stopped"
  else
    cutover_active=true
    resume_previous_without_restore \
      || die "automatic restart recovery failed; app remains gated or stopped"
  fi
  log "interrupted deployment recovered; the next trigger will retry the update"
  exit 0
fi

[[ -f "$runtime_dir/data.db" ]] || die "production database not found: $runtime_dir/data.db"

prune_deploy_backups
check_free_space || die "disk-space preflight failed"

git_cmd=(git -c "safe.directory=$repo" -C "$repo")
actual_remote=$("${git_cmd[@]}" remote get-url "$remote")
[[ "$actual_remote" == "$expected_remote" ]] \
  || die "unexpected $remote URL; refusing to fetch or deploy"
current_branch=$("${git_cmd[@]}" symbolic-ref --quiet --short HEAD) \
  || die "repository must be on the $branch branch"
[[ "$current_branch" == "$branch" ]] || die "repository is on $current_branch, expected $branch"
"${git_cmd[@]}" diff --quiet || die "tracked working tree has local modifications"
"${git_cmd[@]}" diff --cached --quiet || die "index has local modifications"

log "fetching $remote/$branch"
"${git_cmd[@]}" fetch --prune "$remote" \
  "refs/heads/$branch:refs/remotes/$remote/$branch"
target=$("${git_cmd[@]}" rev-parse "refs/remotes/$remote/$branch^{commit}")
[[ "$target" =~ ^[0-9a-f]{40}$ ]] || die "remote target is not a commit SHA"

if [[ -f "$marker_file" ]]; then
  deployed=$(tr -d '\r\n' < "$marker_file")
  [[ "$deployed" =~ ^[0-9a-f]{40}$ ]] || die "invalid deployed commit marker"
  "${git_cmd[@]}" cat-file -e "$deployed^{commit}" 2>/dev/null \
    || die "deployed commit marker is not available in the repository"
  "${git_cmd[@]}" merge-base --is-ancestor "$deployed" "$target" \
    || die "$remote/$branch is not a fast-forward from the last successful deployment"
fi

head=$("${git_cmd[@]}" rev-parse HEAD)
if [[ "$head" != "$target" ]]; then
  "${git_cmd[@]}" merge-base --is-ancestor "$head" "$target" \
    || die "checkout cannot be fast-forwarded to $remote/$branch"
  log "fast-forwarding checkout $head -> $target"
  "${git_cmd[@]}" merge --ff-only "$target"
fi
[[ "$("${git_cmd[@]}" rev-parse HEAD)" == "$target" ]] || die "checkout did not reach target"
cmp --silent "$compose_file" "$repo/deploy/pi2/compose.yaml" \
  || die "installed Compose differs from the reviewed repository template"

running_revision=
if docker inspect "$container_name" >/dev/null 2>&1; then
  running_revision=$(docker inspect --format \
    '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
    "$container_name" 2>/dev/null || true)
fi
if [[ "$deployed" == "$target" && "$running_revision" == "$target" \
  && ! -e "$maintenance_file" ]] && http_ok "$local_health_url"; then
  log "already running healthy commit $target"
  exit 0
fi

candidate_image="$image_repository:$target"
image_revision=$(docker image inspect --format \
  '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
  "$candidate_image" 2>/dev/null || true)
if [[ "$image_revision" != "$target" ]]; then
  log "building and verifying immutable image $candidate_image"
  docker build --pull \
    --file "$repo/deploy/pi2/Dockerfile" \
    --build-arg "COMMIT_SHA=$target" \
    --tag "$candidate_image" \
    "$repo"
fi
image_revision=$(docker image inspect --format \
  '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$candidate_image")
[[ "$image_revision" == "$target" ]] || die "candidate image revision label is incorrect"

if [[ -n "$deployed" && -f "$image_marker_file" ]]; then
  deployed_image_ref=$(tr -d '\r\n' < "$image_marker_file")
  deployed_image_revision=$(docker image inspect --format \
    '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
    "$deployed_image_ref" 2>/dev/null || true)
  if [[ "$deployed_image_revision" == "$deployed" ]]; then
    old_image=$(docker image inspect --format '{{.Id}}' "$deployed_image_ref")
  fi
fi
if [[ -z "$old_image" ]] && docker inspect "$container_name" >/dev/null 2>&1; then
  old_image=$(docker inspect --format '{{.Image}}' "$container_name")
fi
if [[ -z "$old_image" && -n "$deployed" ]]; then
  old_image=$(docker image inspect --format '{{.Id}}' \
    "$image_repository:$deployed" 2>/dev/null || true)
fi
[[ "$old_image" =~ ^sha256:[0-9a-f]{64}$ ]] \
  || die "cannot identify an immutable rollback image"
docker image inspect "$old_image" >/dev/null 2>&1 \
  || die "rollback image is not available: $old_image"

if docker inspect "$container_name" >/dev/null 2>&1; then
  data_source=$(docker inspect --format \
    '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' \
    "$container_name" 2>/dev/null || true)
  db_contract=$(docker inspect --format \
    '{{range .Config.Env}}{{if eq . "DB_PATH=/data/data.db"}}ok{{end}}{{end}}' \
    "$container_name" 2>/dev/null || true)
  uploads_contract=$(docker inspect --format \
    '{{range .Config.Env}}{{if eq . "UPLOAD_DIR=/data/uploads"}}ok{{end}}{{end}}' \
    "$container_name" 2>/dev/null || true)
  [[ "$data_source" == "$runtime_dir" && "$db_contract" == ok && "$uploads_contract" == ok ]] \
    || die "running container does not match the reviewed production data contract"
fi

backup_id="$(date -u +'%Y%m%dT%H%M%SZ')-${target:0:12}-preflight-$$"
backup_parent="$backup_root/$backup_id"
backup_container_path="/data/deploy-backups/$backup_id"
install -d -m 700 "$backup_parent"
log "creating a consistent online snapshot for candidate preflight"
if [[ "$(docker inspect --format '{{.State.Running}}' "$container_name" 2>/dev/null || true)" == "true" ]]; then
  docker exec --user "$(id -u):$(id -g)" \
    --env "BACKUP_DIR=$backup_container_path" \
    "$container_name" npm run backup
else
  docker run --rm --user "$(id -u):$(id -g)" \
    --env DB_PATH=/data/data.db \
    --env UPLOAD_DIR=/data/uploads \
    --env "BACKUP_DIR=$backup_container_path" \
    --volume "$runtime_dir:/data" \
    --entrypoint npm "$old_image" run backup
fi

mapfile -t snapshots < <(find "$backup_parent" -mindepth 1 -maxdepth 1 -type d -print)
[[ ${#snapshots[@]} -eq 1 ]] || die "preflight backup did not create exactly one snapshot"
snapshot=${snapshots[0]}
[[ -f "$snapshot/data.db" && -d "$snapshot/uploads" ]] || die "preflight snapshot is incomplete"

preflight_snapshot="$backup_parent/preflight-data"
install -d -m 700 "$preflight_snapshot"
cp -a "$snapshot/." "$preflight_snapshot/"

candidate_container="split-bill-preflight-${target:0:12}-$$"
candidate_args=(
  run --detach --name "$candidate_container" --network none
  --env-file "$env_file"
  --env NODE_ENV=production
  --env PORT=3100
  --env HOST=127.0.0.1
  --env DB_PATH=/data/data.db
  --env UPLOAD_DIR=/data/uploads
  --env BACKUP_DIR=/data/backups
  --env MAINTENANCE_FILE=/data/.maintenance
  --env ALLOW_PUBLIC_ACCESS=1
  --volume "$preflight_snapshot:/data"
)
if [[ -d "$repo/codex" ]]; then
  candidate_args+=(--volume "$repo/codex:/app/codex:ro")
fi
candidate_args+=("$candidate_image")
log "starting candidate against the snapshot copy"
docker "${candidate_args[@]}" >/dev/null

candidate_ok=false
state=created
health=none
deadline=$((SECONDS + 60))
while (( SECONDS < deadline )); do
  state=$(docker inspect --format '{{.State.Status}}' "$candidate_container" 2>/dev/null || true)
  health=$(docker inspect --format \
    '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
    "$candidate_container" 2>/dev/null || true)
  case "$state:$health" in
    running:healthy)
      candidate_ok=true
      break
      ;;
    created:*|running:starting|running:unhealthy)
      ;;
    *)
      break
      ;;
  esac
  sleep 2
done
[[ "$candidate_ok" == true ]] \
  || die "candidate did not become healthy within 60 seconds (status=$state health=$health)"
docker exec "$candidate_container" node -e '
  const fs = require("fs");
  const path = require("path");
  const Database = require("better-sqlite3");
  const db = new Database(process.env.DB_PATH, { readonly: true, fileMustExist: true });
  const integrity = db.pragma("integrity_check", { simple: true });
  const foreignKeys = db.pragma("foreign_key_check");
  const receipts = db.prepare("SELECT receipt FROM expenses WHERE receipt IS NOT NULL").all();
  db.close();
  if (integrity !== "ok" || foreignKeys.length !== 0) process.exit(1);
  for (const { receipt } of receipts) {
    if (typeof receipt !== "string" || path.basename(receipt) !== receipt) process.exit(1);
    if (!fs.statSync(path.join(process.env.UPLOAD_DIR, receipt)).isFile()) process.exit(1);
  }
' || die "candidate snapshot integrity checks failed"
docker rm -f "$candidate_container" >/dev/null
candidate_container=
rm -rf "$preflight_snapshot"

cutover_id="$(date -u +'%Y%m%dT%H%M%SZ')-${target:0:12}-cutover-$$"
cutover_parent="$backup_root/$cutover_id"
cutover_container_path="/data/deploy-backups/$cutover_id"
install -d -m 700 "$cutover_parent"
if ! write_state preparing; then
  die "could not create durable deployment recovery state"
fi
cutover_active=true

maintenance_tmp="$maintenance_file.tmp.$$"
if ! printf '%s\n' "$target" > "$maintenance_tmp" \
  || ! chmod 600 "$maintenance_tmp" \
  || ! mv -f "$maintenance_tmp" "$maintenance_file"; then
  rm -f "$maintenance_tmp"
  fail_before_data_change "could not enable the maintenance gate"
fi

log "stopping the current app for the final cutover snapshot"
if ! stop_and_confirm; then
  fail_before_data_change "could not stop the current app; production data was not touched"
fi
if ! docker run --rm --user "$(id -u):$(id -g)" \
  --env DB_PATH=/data/data.db \
  --env UPLOAD_DIR=/data/uploads \
  --env "BACKUP_DIR=$cutover_container_path" \
  --volume "$runtime_dir:/data" \
  --entrypoint npm "$old_image" run backup; then
  fail_before_data_change "could not create the final cutover snapshot"
fi
mapfile -t cutover_snapshots < <(find "$cutover_parent" -mindepth 1 -maxdepth 1 -type d -print)
if [[ ${#cutover_snapshots[@]} -ne 1 ]]; then
  fail_before_data_change "final cutover backup did not create exactly one snapshot"
fi
snapshot=${cutover_snapshots[0]}
snapshot_rel=${snapshot#"$runtime_dir/"}
if [[ "$snapshot_rel" == "$snapshot" || ! -f "$snapshot/data.db" || ! -d "$snapshot/uploads" ]]; then
  fail_before_data_change "final cutover snapshot is incomplete"
fi
if ! write_state rollback-ready "$snapshot_rel"; then
  fail_before_data_change "could not record the rollback snapshot"
fi
rollback_ready=true

log "deploying $candidate_image behind the maintenance gate"
if ! start_image "$candidate_image"; then
  fail_with_rollback "Compose failed to start the candidate"
fi
if ! wait_for_live_health; then
  fail_with_rollback "candidate failed the live health check"
fi

maintenance_status=$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --max-time 5 http://192.168.1.120:3100/ 2>/dev/null || true)
if [[ "$maintenance_status" != 503 ]]; then
  fail_with_rollback "candidate did not enforce the maintenance gate"
fi

running_revision=$(docker inspect --format \
  '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$container_name" 2>/dev/null || true)
running_image=$(docker inspect --format '{{.Config.Image}}' "$container_name" 2>/dev/null || true)
if [[ "$running_revision" != "$target" || "$running_image" != "$candidate_image" ]]; then
  fail_with_rollback "running container does not match the target commit"
fi
if ! docker exec "$container_name" node -e '
  const fs = require("fs");
  const path = require("path");
  const Database = require("better-sqlite3");
  const db = new Database(process.env.DB_PATH, { readonly: true, fileMustExist: true });
  const integrity = db.pragma("integrity_check", { simple: true });
  const foreignKeys = db.pragma("foreign_key_check");
  const receipts = db.prepare("SELECT receipt FROM expenses WHERE receipt IS NOT NULL").all();
  db.close();
  if (integrity !== "ok" || foreignKeys.length !== 0) process.exit(1);
  for (const { receipt } of receipts) {
    if (typeof receipt !== "string" || path.basename(receipt) !== receipt) process.exit(1);
    if (!fs.statSync(path.join(process.env.UPLOAD_DIR, receipt)).isFile()) process.exit(1);
  }
'; then
  fail_with_rollback "live data integrity checks failed"
fi

cutover_active=false
rollback_ready=false
if ! write_state committed "$snapshot_rel"; then
  cutover_active=true
  rollback_ready=true
  fail_with_rollback "could not record the committed deployment state"
fi
if ! complete_committed_deployment true; then
  die "candidate is committed but forward completion failed; app remains gated"
fi

if ! http_ok "$public_health_url"; then
  log "WARNING: local deployment is healthy, but public health check failed: $public_health_url"
fi
prune_deploy_backups
prune_app_images
log "successfully deployed $target (rollback snapshot: $snapshot)"
