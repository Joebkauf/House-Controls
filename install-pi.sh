#!/usr/bin/env bash
# Optimum Remote: put the bridge on a Raspberry Pi (Raspberry Pi OS, 64-bit) and
# keep it running at boot. Safe to run again later: it updates in place.
#
#   curl -fsSL https://raw.githubusercontent.com/joebkauf/optimum-remote/main/install-pi.sh | bash
#
# Afterwards the remote is at  http://tv.local:4680  on the house Wi-Fi.
set -euo pipefail
REPO="${REPO:-https://github.com/joebkauf/optimum-remote.git}"
DIR="${DIR:-/opt/optimum-remote}"
NAME="${NAME:-tv}"          # the Pi's name on the network → http://tv.local:4680
PORT="${PORT:-4680}"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

say "Updating the Pi's package list"
sudo apt-get update -y -qq
sudo apt-get install -y -qq git curl avahi-daemon >/dev/null

if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/v//' | cut -d. -f1)" -lt 20 ]; then
  say "Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null
  sudo apt-get install -y -qq nodejs >/dev/null
fi
echo "Node $(node -v)"

if [ -d "$DIR/.git" ]; then
  say "Updating Optimum Remote in $DIR"
  sudo git -C "$DIR" pull --ff-only
else
  say "Downloading Optimum Remote into $DIR"
  sudo git clone --quiet "$REPO" "$DIR"
fi
sudo chown -R "$USER:$USER" "$DIR"
mkdir -p "$DIR/data"

say "Installing its pieces"
(cd "$DIR" && npm install --omit=dev --no-audit --no-fund --loglevel=error)

say "Making it start at boot"
sudo tee /etc/systemd/system/optimum-remote.service >/dev/null <<UNIT
[Unit]
Description=Optimum Remote bridge
After=network-online.target
Wants=network-online.target

[Service]
User=$USER
WorkingDirectory=$DIR
Environment=PORT=$PORT
Environment=DATA_DIR=$DIR/data
ExecStart=/usr/bin/env node server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --quiet optimum-remote
sudo systemctl restart optimum-remote

if [ "$(hostname)" != "$NAME" ]; then
  say "Naming this Pi '$NAME' so the address is http://$NAME.local:$PORT"
  if command -v raspi-config >/dev/null 2>&1; then sudo raspi-config nonint do_hostname "$NAME"; else
    echo "$NAME" | sudo tee /etc/hostname >/dev/null
    sudo sed -i "s/^127\.0\.1\.1.*/127.0.1.1\t$NAME/" /etc/hosts
  fi
  sudo systemctl restart avahi-daemon || true
fi

sleep 2
IP="$(hostname -I | awk '{print $1}')"
if curl -fs "http://127.0.0.1:$PORT/api/state" >/dev/null; then
  say "Done. On the iPad or iPhone open:  http://$NAME.local:$PORT   (or http://$IP:$PORT)"
  echo "Then: Safari share button → Add to Home Screen. Setup is the ⚙ at the bottom left."
else
  say "The bridge did not answer yet. Its log:"
  sudo journalctl -u optimum-remote -n 30 --no-pager
fi
