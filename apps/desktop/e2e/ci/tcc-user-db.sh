# The runner user's TCC database, for grant-reminders-tcc.sh and
# probe-helper-access.sh (sourced, then `tcc_user_db`). Up to macOS 26 it
# is ~/Library/Application Support/com.apple.TCC/TCC.db. macOS 27 moved the
# per-user tccd into a daemon container (its binary resolves the same
# relative path under a `containerBasePath`), and that directory no longer
# exists in the home folder: on the xcode-27 image the seed died with
# "unable to open database file" at the old path (run 41698601075). Both
# places are TCC-protected, so every look goes through sudo. No match is a
# loud failure that lists what is there: a default path would seed a file
# tccd never reads, and the probe would then fail without saying why.
tcc_user_db() {
  local legacy="$HOME/Library/Application Support/com.apple.TCC/TCC.db"
  if sudo test -f "$legacy"; then
    echo "$legacy"
    return 0
  fi
  local containers="$HOME/Library/Daemon Containers"
  local found
  found=$(sudo find "$containers" -maxdepth 7 -type f -name TCC.db \
    -path '*/Library/Application Support/com.apple.TCC/*' 2>/dev/null | head -1 || true)
  if [ -n "$found" ]; then
    echo "$found"
    return 0
  fi
  {
    echo "no per-user TCC.db: not at $legacy, none under $containers"
    echo "--- $HOME/Library/Application Support"
    sudo ls -la "$HOME/Library/Application Support" || true
    echo "--- $containers"
    sudo ls -la "$containers" || true
    echo "--- every TCC.db under $HOME/Library (depth 8)"
    sudo find "$HOME/Library" -maxdepth 8 -name 'TCC.db' 2>/dev/null || true
    echo "--- tccd log (last 10 minutes)"
    sudo log show --last 10m --predicate 'process == "tccd"' --style compact 2>/dev/null | tail -40 || true
  } >&2
  return 1
}
