#!/bin/bash
# Refresh sibir.ics from KHL API and publish to GitHub (for Apple / Google Calendar).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:$PATH"

LOG_DIR="${HOME}/Library/Logs"
mkdir -p "$LOG_DIR"
LOG="${LOG_DIR}/sibir-calendar-sync.log"
LOCK_DIR="${TMPDIR:-/tmp}/sibir-calendar-sync.lock"

exec >>"$LOG" 2>&1
echo "---- $(date -Iseconds) ----"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "Another sync is already running"
  exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

ok=0
for attempt in 1 2 3; do
  if node scripts/sync-ics.mjs; then
    ok=1
    break
  fi
  echo "sync-ics failed (attempt ${attempt}), retrying in 30s"
  sleep 30
done
if [[ "$ok" != 1 ]]; then
  echo "sync-ics failed after 3 attempts"
  exit 1
fi

REPO="karpenko-chernikov/sibir-calendar"
PATH_IN_REPO="sibir.ics"

LOCAL_SHA="$(python3 - <<'PY'
import hashlib, pathlib
data = pathlib.Path("sibir.ics").read_bytes()
print(hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest())
PY
)"

publish() {
  local sha="$1"
  local content_b64
  content_b64="$(base64 < sibir.ics | tr -d '\n')"
  gh api --method PUT "repos/${REPO}/contents/${PATH_IN_REPO}" \
    -f message="chore: refresh HC Sibir KHL calendar" \
    -f content="$content_b64" \
    -f sha="$sha" \
    --jq '{commit: .commit.sha, path: .content.path}'
}

OLD_SHA="$(gh api "repos/${REPO}/contents/${PATH_IN_REPO}" --jq .sha)"
if [[ -z "$OLD_SHA" ]]; then
  echo "Failed to read current file sha from GitHub"
  exit 1
fi

if [[ "$LOCAL_SHA" == "$OLD_SHA" ]]; then
  echo "No calendar changes"
  exit 0
fi

if publish "$OLD_SHA"; then
  echo "Published update"
  exit 0
fi

# Retry once on concurrent update (HTTP 409)
echo "Publish conflict — retrying with fresh sha"
OLD_SHA="$(gh api "repos/${REPO}/contents/${PATH_IN_REPO}" --jq .sha)"
if [[ "$LOCAL_SHA" == "$OLD_SHA" ]]; then
  echo "Already up to date after conflict"
  exit 0
fi
publish "$OLD_SHA"
echo "Published update after retry"
