#!/bin/bash
set -euo pipefail
umask 077
script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
existing=$(command -v espeak-ng || true)
if { [ -n "$existing" ] && [ "$existing" != "$HOME/.local/bin/espeak-ng" ]; } || command -v espeak >/dev/null; then
  echo 'The VM local speech engine is already available.'
  exit 0
fi
mkdir -p "$HOME/dant/runtime/speech" "$HOME/.local/bin"
if [ ! -f "$HOME/dant/runtime/speech/deployment.json" ]; then
python3 "$script_dir/install-speech.py" "$HOME/dant/runtime/speech"
fi
cat > "$HOME/.local/bin/espeak-ng" <<'SH'
#!/bin/sh
base="$HOME/dant/runtime/speech"
export LD_LIBRARY_PATH="$base/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
exec "$base/usr/bin/espeak-ng" --path="$base/usr/lib/x86_64-linux-gnu" "$@"
SH
chmod 700 "$HOME/.local/bin/espeak-ng"
"$HOME/.local/bin/espeak-ng" --version
echo "Pinned Ubuntu speech package hashes and sources recorded in $HOME/dant/runtime/speech/deployment.json"
