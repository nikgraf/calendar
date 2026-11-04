# The runner user's TCC database, for grant-reminders-tcc.sh and
# probe-helper-access.sh (sourced, then `tcc_user_db`). Up to macOS 26 it
# is ~/Library/Application Support/com.apple.TCC/TCC.db. macOS 27 gives the
# per-user tccd a protected system container and the same relative path
# inside it — /private/var/containers/Data/ProtectedSystem/<uuid>/Data/
# Library/Application Support/com.apple.TCC/TCC.db (read off a macOS 27.2
# Mac with `lsof -p <user tccd>` during a `tccutil reset`; on the xcode-27
# image the seed had died with "unable to open database file" at the old
# path, run 41698601075, and nothing under ~/Library, run 41700985320).
# Both places are TCC-protected, so every look goes through sudo. No
# match is a loud failure that lists what is there: a default path would
# seed a file tccd never reads, and the probe would then fail without
# saying why.
tcc_user_db() {
  local legacy="$HOME/Library/Application Support/com.apple.TCC/TCC.db"
  if sudo test -f "$legacy"; then
    echo "$legacy"
    return 0
  fi
  local found
  found=$(tcc_container_db)
  if [ -z "$found" ]; then
    # tccd makes the file on its first write; a reset is the cheapest one
    # (the runner user has no grants to lose).
    tccutil reset Reminders >/dev/null 2>&1 || true
    tccutil reset Calendar >/dev/null 2>&1 || true
    found=$(tcc_container_db)
  fi
  if [ -n "$found" ]; then
    echo "$found"
    return 0
  fi
  {
    echo "no per-user TCC.db: not at $legacy, none in a protected system container of uid $(id -u)"
    echo "--- /private/var/containers/Data/ProtectedSystem"
    sudo ls -la /private/var/containers/Data/ProtectedSystem || true
    local container
    for container in /private/var/containers/Data/ProtectedSystem/*/; do
      echo "--- $container (Data owner $(sudo stat -f %u "${container}Data" 2>&1))"
      sudo plutil -p "${container}.com.apple.containermanagerd.metadata.plist" 2>&1 \
        | grep -i -E 'Identifier|UID|Name' | head -4 || true
    done
    echo "--- tccd log (last 10 minutes)"
    sudo log show --last 10m --predicate 'process == "tccd"' --style compact 2>/dev/null \
      | grep -v 'xpc:connection' | tail -40 || true
  } >&2
  return 1
}

# The current user's TCC.db among the protected system containers: the one
# whose Data directory the user owns (one container per daemon and user).
# Reads every match rather than stopping at the first, so a pipeline with
# `pipefail` never sees a SIGPIPE'd find.
tcc_container_db() {
  local uid
  uid=$(id -u)
  sudo find /private/var/containers/Data/ProtectedSystem -maxdepth 6 -type f -name TCC.db \
    -path '*/Data/Library/Application Support/com.apple.TCC/*' 2>/dev/null \
    | while IFS= read -r db; do
      local data="${db%/Library/Application Support/com.apple.TCC/TCC.db}"
      if [ "$(sudo stat -f %u "$data" 2>/dev/null)" = "$uid" ]; then
        echo "$db"
      fi
    done | sed -n '1p'
}
