#!/bin/bash
set -euo pipefail
umask 077
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
python3 "$script_dir/install-transcription.py" "$script_dir/transcription-requirements.txt"
