#!/bin/bash
# Sets up Ctrl+F by meaning on this Mac.
#
#   ./setup.sh               register the local AI bridge with Chrome, then check it
#   ./setup.sh --id <id>     also allow another extension ID (if Chrome shows a different one)
#   ./setup.sh --uninstall   remove the bridge registration
#
# The bridge lets the extension ask the AI tools on this Mac (agy, then grok, then codex)
# for a written answer. Chrome only lets an extension talk to programs registered for its
# exact ID. An unpacked extension's ID comes from its folder path, so run this again if
# you move the folder. The bridge is copied to ~/Library/Application Support/CtrlFByMeaning,
# because macOS won't let Chrome start programs inside Documents, Desktop or Downloads.
# Run this again after updating the project, to refresh that copy.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
EXT="$ROOT/extension"
INSTALL="$HOME/Library/Application Support/CtrlFByMeaning"
BRIDGE="$INSTALL/ai-bridge/ctrlf-bridge"
NAME="com.ctrlf_by_meaning.bridge"
SUPPORT="$HOME/Library/Application Support"
BROWSERS=("Google/Chrome" "Google/Chrome Beta" "Google/Chrome Dev" "Google/Chrome Canary" "Chromium")

extra_ids=()
uninstall=false
while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) uninstall=true ;;
    --id) shift; extra_ids+=("$1") ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

if $uninstall; then
  for b in "${BROWSERS[@]}"; do rm -f "$SUPPORT/$b/NativeMessagingHosts/$NAME.json"; done
  rm -rf "$INSTALL"
  echo "Removed the AI bridge and its registration."
  exit 0
fi

# Chrome's ID for an unpacked extension: SHA-256 of its folder path, first 32 hex digits,
# written with the letters a–p instead of 0–f.
ID="$(python3 -c 'import hashlib,sys; print("".join(chr(97+int(c,16)) for c in hashlib.sha256(sys.argv[1].encode()).hexdigest()[:32]))' "$EXT")"
origins="\"chrome-extension://$ID/\""
for extra in "${extra_ids[@]+"${extra_ids[@]}"}"; do origins="$origins, \"chrome-extension://$extra/\""; done

mkdir -p "$INSTALL"
rm -rf "$INSTALL/ai-bridge"
cp -R "$ROOT/ai-bridge" "$INSTALL/ai-bridge"
chmod +x "$BRIDGE"
echo "✓ Installed the AI bridge in $INSTALL"
installed=0
for b in "${BROWSERS[@]}"; do
  [ -d "$SUPPORT/$b" ] || continue
  mkdir -p "$SUPPORT/$b/NativeMessagingHosts"
  cat > "$SUPPORT/$b/NativeMessagingHosts/$NAME.json" <<JSON
{
  "name": "$NAME",
  "description": "Ctrl+F by meaning: local AI bridge (agy, grok, codex)",
  "path": "$BRIDGE",
  "type": "stdio",
  "allowed_origins": [$origins]
}
JSON
  echo "✓ Registered the AI bridge with $b"
  installed=$((installed + 1))
done
[ "$installed" -gt 0 ] || { echo "No Chrome found under $SUPPORT." >&2; exit 1; }

# Ask the bridge which AI tools it can find, the way Chrome will start it.
tools="$(printf '%s' '{"type":"ping"}' | python3 -c '
import json, struct, subprocess, sys
msg = sys.stdin.read().encode()
out = subprocess.run([sys.argv[1]], input=struct.pack("<I", len(msg)) + msg, capture_output=True, env={"HOME": sys.argv[2], "PATH": "/usr/bin:/bin"}, timeout=20).stdout
reply = json.loads(out[4:4 + struct.unpack("<I", out[:4])[0]])
print("  ".join(f"{k} {chr(10003) if v else chr(10007)}" for k, v in reply["tools"].items()))
' "$BRIDGE" "$HOME" 2>/dev/null || echo "couldn't start the bridge (is Node.js installed?)")"
echo "✓ AI tools the bridge can use: $tools"

cat <<DONE

Extension ID: $ID

Next, in Chrome:
  1. Open chrome://extensions and turn on Developer mode (top right).
  2. Click "Load unpacked" and choose: $EXT
     (Already loaded? Click the reload arrow on its card instead.)
  3. Click "Details" → "Extension options", and paste your Jev key.
  4. On any page, press Control+Shift+F and ask a question.

If the settings page shows a different extension ID, run:  ./setup.sh --id <that id>
DONE
