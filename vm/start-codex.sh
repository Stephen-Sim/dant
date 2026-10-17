#!/bin/bash
set -euo pipefail
export DISPLAY=:0
export CODEX_HOME="$HOME/.dant-codex"
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:$PATH"
mkdir -p "$CODEX_HOME" "$HOME/work"
cd "$HOME/work"
exec codex app-server --listen stdio://
