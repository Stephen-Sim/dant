#!/bin/bash
set -euo pipefail
export DISPLAY=:0
export CODEX_HOME=/home/dant/.dant-codex
export PATH=/usr/local/bin:/usr/bin:$PATH
mkdir -p "$CODEX_HOME" /home/dant/work
cd /home/dant/work
exec /usr/local/bin/codex app-server --listen stdio://
