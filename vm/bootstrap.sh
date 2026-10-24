#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
exec > >(tee -a /var/log/dant-bootstrap.log) 2>&1
trap 'echo "dant bootstrap failed at line $LINENO (exit $?). systemd will retry."' ERR

retry() {
  local attempt
  for attempt in 1 2 3 4 5; do
    if "$@"; then return 0; fi
    echo "Attempt $attempt failed; retrying in $((attempt * 10)) seconds."
    sleep "$((attempt * 10))"
  done
  return 1
}

echo "Starting dant guest setup at $(date -Is)"
retry apt-get -o Acquire::Retries=3 -o DPkg::Lock::Timeout=180 update
retry apt-get -o Acquire::Retries=3 -o DPkg::Lock::Timeout=180 install -y \
  xfce4 xfce4-terminal xvfb x11-utils x11-xserver-utils xdotool scrot xclip \
    dbus-x11 python3 python3-pip nodejs npm fonts-noto-cjk firefox espeak-ng util-linux bubblewrap apparmor
python3 /opt/dant/conversation-namespace.py --install --user dant
retry npm install -g @openai/codex@0.163.0
install -d -o dant -g dant /home/dant/work /home/dant/.dant-codex
chmod +x /opt/dant/start-codex.sh /opt/dant/desktop.py
loginctl enable-linger dant
systemctl daemon-reload
systemctl enable --now dant-display.service dant-desktop.service dant-guest.service

# Service launch alone is not readiness: verify the display, screenshot bridge
# and installed Codex before exposing the ready marker to the Windows host.
ready=false
for attempt in $(seq 1 60); do
  if systemctl is-active --quiet dant-display.service dant-desktop.service dant-guest.service && \
     runuser -u dant -- env DISPLAY=:0 xdpyinfo >/dev/null 2>&1 && \
     python3 /opt/dant/network_config.py bootstrap-screen-check && \
     /usr/local/bin/codex --version; then
    ready=true
    break
  fi
  sleep 3
done
if [ "$ready" != true ]; then
  echo 'Desktop services did not pass readiness checks.'
  exit 1
fi
touch /home/dant/work/.dant-ready
chown dant:dant /home/dant/work/.dant-ready
echo "dant guest is ready at $(date -Is)"
