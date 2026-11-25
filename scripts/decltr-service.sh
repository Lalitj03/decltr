#!/usr/bin/env bash
# Run the Decltr server as a background service on macOS (a LaunchAgent), and control it.
#
#   decltr-service.sh install [--replace]   set it up to start at login, and start it now
#   decltr-service.sh start | stop | restart
#   decltr-service.sh status                is it running, and is it healthy
#   decltr-service.sh logs [-f]             show the log (-f keeps following it)
#   decltr-service.sh uninstall             stop it and remove it from login items
#
# Behaviour worth knowing:
#   - "stop" really stops it and keeps it stopped. The service is only brought back after a crash or a
#     restart request, never after a deliberate stop. It starts again at your next login, or with "start".
#   - Your API key stays in the Keychain. Nothing secret is written into the service definition.
#
# DECLTR_LABEL and DECLTR_PORT can be set to run a second, separate copy (the tests use this).
set -euo pipefail

LABEL="${DECLTR_LABEL:-com.decltr.server}"
PORT="${DECLTR_PORT:-47821}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOMAIN="gui/$(id -u)"
TARGET="$DOMAIN/$LABEL"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/$(echo "${LABEL#com.}" | tr '.' '-').log"
ORIGIN="chrome-extension://${DECLTR_EXTENSION_ID:-jldfhgcphcbkmjmlkkioebphdaipkcjf}"
OLD_LABEL="com.declt.server" # the service before the product was renamed

die() { echo "Error: $*" >&2; exit 1; }
is_loaded() { launchctl print "$TARGET" >/dev/null 2>&1; }
service_pid() { launchctl print "$TARGET" 2>/dev/null | awk '/^[[:space:]]*pid = /{print $3; exit}'; }
port_owner() { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1 || true; }

health_json() {
  curl -s -m 2 -X POST "http://127.0.0.1:$PORT/v1/health" -H 'content-type: application/json' -H "origin: $ORIGIN" -d '{}' 2>/dev/null || true
}

# Wait until the server answers, so the command's result is the truth and not a hope.
wait_healthy() {
  for _ in $(seq 1 30); do
    [[ "$(health_json)" == *'"ok":true'* ]] && return 0
    sleep 0.5
  done
  return 1
}
wait_port_free() {
  for _ in $(seq 1 30); do
    [[ -z "$(port_owner)" ]] && return 0
    sleep 0.5
  done
  return 1
}

describe_health() {
  health_json | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const h = JSON.parse(s);
        console.log(`  answering:     yes (v${h.version}, pid ${h.pid}, ${h.provider} / ${h.model})`);
        console.log(`  API key:       ${h.keyConfigured ? "found" : "NOT FOUND (run: npm run set-key)"}`);
        console.log(`  panel control: ${h.managed ? "enabled (the panel can restart or stop it)" : "off (started by hand)"}`);
      } catch { console.log("  answering:     no"); }
    });'
}

retire_old_service() {
  launchctl bootout "$DOMAIN/$OLD_LABEL" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/$OLD_LABEL.plist"
}

write_plist() {
  local node_bin="$1"
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$node_bin</string>
    <string>$ROOT/server/bin/decltr-server.js</string>
    <string>start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DECLTR_MANAGED</key><string>1</string>
    <key>DECLTR_PORT</key><string>$PORT</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <!-- Bring it back after a crash or a restart request (non-zero exit), but not after a deliberate stop (exit 0). -->
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
  chmod 600 "$PLIST"
}

cmd_install() {
  local replace=0
  [[ "${1:-}" == "--replace" ]] && replace=1
  local node_bin
  node_bin="$(command -v node || true)"
  [[ -n "$node_bin" ]] || die "Node.js was not found in your PATH. Install Node 20+ and try again."

  if ! security find-generic-password -s decltr -a vertex-api-key >/dev/null 2>&1 \
     && ! security find-generic-password -s declt -a vertex-api-key >/dev/null 2>&1; then
    echo "Note: no API key in the Keychain yet. Run: npm run set-key"
  fi

  retire_old_service

  # Something else on the port would make the service fail over and over. Say so instead.
  local owner mine=""
  owner="$(port_owner)"
  is_loaded && mine="$(service_pid)"
  if [[ -n "$owner" && "$owner" != "$mine" ]]; then
    local cmd
    cmd="$(ps -o command= -p "$owner" 2>/dev/null || true)"
    if [[ "$replace" == 1 && "$cmd" == *decltr-server.js* || "$replace" == 1 && "$cmd" == *declt-server.js* ]]; then
      echo "Stopping the Decltr server that is already running (pid $owner)…"
      kill "$owner"
      wait_port_free || die "pid $owner did not stop."
    else
      die "port $PORT is already in use by pid $owner:
  $cmd
Stop it (Ctrl+C in its terminal), or run this again with --replace to stop it for you (only works for a Decltr server)."
    fi
  fi

  is_loaded && launchctl bootout "$TARGET" 2>/dev/null || true
  write_plist "$node_bin"
  launchctl bootstrap "$DOMAIN" "$PLIST"

  if wait_healthy; then
    echo "Decltr server is installed and running. It will start at every login."
    describe_health
  else
    echo "Installed, but the server is not answering yet. Check the log: scripts/decltr-service.sh logs" >&2
    exit 1
  fi
  echo "Control it with: npm run server:stop | server:restart | server:status | server:logs"
}

cmd_uninstall() {
  launchctl bootout "$TARGET" 2>/dev/null || true
  rm -f "$PLIST"
  retire_old_service
  echo "Decltr server removed from login items. Its log and your Keychain entries were left alone."
}

cmd_start() {
  [[ -f "$PLIST" ]] || die "not installed yet. Run: npm run server:install"
  if is_loaded; then
    launchctl kickstart "$TARGET"
  else
    launchctl bootstrap "$DOMAIN" "$PLIST"
  fi
  wait_healthy || die "started, but it is not answering. Check the log: scripts/decltr-service.sh logs"
  echo "Started."
  describe_health
}

cmd_stop() {
  if ! is_loaded; then echo "Already stopped."; return 0; fi
  local pid
  pid="$(service_pid)"
  if [[ -z "$pid" ]]; then echo "Already stopped."; return 0; fi
  # SIGTERM is a clean exit (code 0), which the service treats as "stay stopped".
  launchctl kill SIGTERM "$TARGET"
  wait_port_free || die "it did not stop. Try: launchctl kill SIGKILL $TARGET"
  echo "Stopped. It stays stopped until you run: npm run server:start (or log in again)."
}

cmd_restart() {
  [[ -f "$PLIST" ]] || die "not installed yet. Run: npm run server:install"
  local before
  before="$(service_pid || true)"
  if is_loaded; then
    launchctl kickstart -k "$TARGET"
  else
    launchctl bootstrap "$DOMAIN" "$PLIST"
  fi
  wait_healthy || die "restarted, but it is not answering. Check the log: scripts/decltr-service.sh logs"
  echo "Restarted${before:+ (was pid $before, now pid $(service_pid))}."
  describe_health
}

cmd_status() {
  echo "Decltr background service ($LABEL)"
  [[ -f "$PLIST" ]] && echo "  installed:     yes (starts at login)" || echo "  installed:     no (run: npm run server:install)"
  if is_loaded; then
    local pid
    pid="$(service_pid || true)"
    [[ -n "$pid" ]] && echo "  state:         running (pid $pid)" || echo "  state:         stopped (npm run server:start to start it)"
  else
    echo "  state:         not loaded"
  fi
  describe_health
  local owner
  owner="$(port_owner)"
  if [[ -n "$owner" ]] && { ! is_loaded || [[ "$owner" != "$(service_pid || true)" ]]; }; then
    echo "  note:          port $PORT is held by pid $owner, which is NOT the background service"
  fi
  echo "  log:           $LOG"
}

cmd_logs() {
  [[ -f "$LOG" ]] || die "no log yet at $LOG"
  if [[ "${1:-}" == "-f" || "${1:-}" == "--follow" ]]; then tail -n 40 -f "$LOG"; else tail -n 60 "$LOG"; fi
}

case "${1:-}" in
  install) shift; cmd_install "$@" ;;
  uninstall) cmd_uninstall ;;
  start) cmd_start ;;
  stop) cmd_stop ;;
  restart) cmd_restart ;;
  status) cmd_status ;;
  logs) shift; cmd_logs "$@" ;;
  *) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; [[ -z "${1:-}" || "$1" == help || "$1" == --help ]] || exit 1 ;;
esac
