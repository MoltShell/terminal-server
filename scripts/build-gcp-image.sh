#!/bin/bash
set -euo pipefail

# Build a reusable GCP custom image for MoltShell terminal servers.
# Usage: ./scripts/build-gcp-image.sh [version]
# Example: ./scripts/build-gcp-image.sh v2

VERSION="${1:-v1}"
PROJECT="termos-70709"
ZONE="us-central1-a"
IMAGE_FAMILY="moltshell-base"
BUILDER_VM="moltshell-image-builder"
IMAGE_NAME="moltshell-base-${VERSION}"

echo "=== Building GCP image: ${IMAGE_NAME} (family: ${IMAGE_FAMILY}) ==="
echo "Project: ${PROJECT}, Zone: ${ZONE}"

# --- Step 1: Create temp VM with startup script ---
echo ""
echo "[1/6] Creating temp VM '${BUILDER_VM}'..."

gcloud compute instances create "${BUILDER_VM}" \
  --project="${PROJECT}" \
  --zone="${ZONE}" \
  --machine-type=e2-medium \
  --image-family=ubuntu-2204-lts \
  --image-project=ubuntu-os-cloud \
  --boot-disk-size=30GB \
  --tags=terminal-server \
  --metadata=startup-script='#!/bin/bash
set -e
exec > /var/log/moltshell-image-setup.log 2>&1
echo "[$(date)] Starting MoltShell image setup..."

# Install Node.js 22
echo "[$(date)] Installing Node.js 22..."
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# Install tmux and nginx
echo "[$(date)] Installing tmux and nginx..."
apt-get update -y
apt-get install -y tmux nginx

# Install tsx globally
echo "[$(date)] Installing tsx globally..."
npm install -g tsx

# Create moltshell user
echo "[$(date)] Creating moltshell user..."
useradd -m -s /bin/bash moltshell 2>/dev/null || true

# Create app directory
mkdir -p /opt/sandboxterminal
chown moltshell:moltshell /opt/sandboxterminal

# Create layout persistence directory
mkdir -p /home/moltshell/.moltshell
chown moltshell:moltshell /home/moltshell/.moltshell

# Configure nginx as reverse proxy (port 80 -> localhost:3001 with WebSocket)
echo "[$(date)] Configuring nginx..."
cat > /etc/nginx/sites-available/moltshell <<'"'"'NGINX'"'"'
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
    }
}
NGINX
ln -sf /etc/nginx/sites-available/moltshell /etc/nginx/sites-enabled/moltshell
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl enable nginx && systemctl restart nginx

# Create systemd service for the terminal server
echo "[$(date)] Creating systemd service..."
cat > /etc/systemd/system/moltshell-terminal.service <<'"'"'SYSTEMD'"'"'
[Unit]
Description=MoltShell Terminal Server
After=network.target

[Service]
Type=simple
User=moltshell
WorkingDirectory=/opt/sandboxterminal
EnvironmentFile=-/opt/sandboxterminal/.env
ExecStart=/usr/bin/tsx server/index.ts
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SYSTEMD
systemctl daemon-reload
systemctl enable moltshell-terminal.service

# Create pull-app.sh script for self-update from GCS
echo "[$(date)] Creating pull-app.sh..."
mkdir -p /opt/moltshell
cat > /opt/moltshell/pull-app.sh <<'"'"'PULLSCRIPT'"'"'
#!/bin/bash
set -euo pipefail

APP_DIR="/opt/sandboxterminal"
VERSION_FILE="${APP_DIR}/.version"
BUCKET="moltshell-releases"

echo "[$(date)] Checking for app updates..."

# Get OAuth2 token from GCE metadata service
TOKEN=$(curl -sf -H "Metadata-Flavor: Google" \
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['"'"'access_token'"'"'])" 2>/dev/null || true)

if [ -z "$TOKEN" ]; then
  echo "[$(date)] Failed to get metadata token, trying public URL..."
  REMOTE_VERSION=$(curl -sf "https://storage.googleapis.com/${BUCKET}/latest-version.txt" || true)
else
  REMOTE_VERSION=$(curl -sf -H "Authorization: Bearer ${TOKEN}" \
    "https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/latest-version.txt?alt=media" || true)
fi

if [ -z "$REMOTE_VERSION" ]; then
  echo "[$(date)] Could not fetch remote version, skipping update."
  exit 0
fi

LOCAL_VERSION=""
if [ -f "$VERSION_FILE" ]; then
  LOCAL_VERSION=$(cat "$VERSION_FILE")
fi

if [ "$REMOTE_VERSION" = "$LOCAL_VERSION" ]; then
  echo "[$(date)] Already up to date (version: ${LOCAL_VERSION})"
  exit 0
fi

echo "[$(date)] Updating: ${LOCAL_VERSION:-none} -> ${REMOTE_VERSION}"

# Download tarball
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

if [ -n "$TOKEN" ]; then
  curl -sf -H "Authorization: Bearer ${TOKEN}" \
    "https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/app.tar.gz?alt=media" \
    -o "${TMPDIR}/app.tar.gz"
else
  curl -sf "https://storage.googleapis.com/${BUCKET}/app.tar.gz" \
    -o "${TMPDIR}/app.tar.gz"
fi

# Save current package.json hash for comparison
OLD_PKG_HASH=""
if [ -f "${APP_DIR}/package.json" ]; then
  OLD_PKG_HASH=$(sha256sum "${APP_DIR}/package.json" | awk '"'"'{print $1}'"'"')
fi

# Extract to app directory
tar -xzf "${TMPDIR}/app.tar.gz" -C "${APP_DIR}"

# Check if package.json changed
NEW_PKG_HASH=""
if [ -f "${APP_DIR}/package.json" ]; then
  NEW_PKG_HASH=$(sha256sum "${APP_DIR}/package.json" | awk '"'"'{print $1}'"'"')
fi

if [ "$OLD_PKG_HASH" != "$NEW_PKG_HASH" ]; then
  echo "[$(date)] package.json changed, running npm install..."
  cd "${APP_DIR}" && npm install --production
fi

# Write new version
echo "$REMOTE_VERSION" > "$VERSION_FILE"
echo "[$(date)] Update complete (version: ${REMOTE_VERSION})"
PULLSCRIPT
chmod +x /opt/moltshell/pull-app.sh
chown -R moltshell:moltshell /opt/moltshell

# Set hostname
hostnamectl set-hostname moltshell

# Write marker file
echo "[$(date)] Image setup complete!"
touch /opt/moltshell/setup-complete
'

echo "VM creation initiated."

# --- Step 2: Wait for setup to complete ---
echo ""
echo "[2/6] Waiting for setup to complete (polling for marker file)..."

MAX_WAIT=600  # 10 minutes
ELAPSED=0
POLL_INTERVAL=15

while [ $ELAPSED -lt $MAX_WAIT ]; do
  sleep $POLL_INTERVAL
  ELAPSED=$((ELAPSED + POLL_INTERVAL))

  if gcloud compute ssh "${BUILDER_VM}" \
    --project="${PROJECT}" \
    --zone="${ZONE}" \
    --command="test -f /opt/moltshell/setup-complete && echo READY" \
    --quiet 2>/dev/null | grep -q "READY"; then
    echo "Setup complete after ~${ELAPSED}s."
    break
  fi

  echo "  Still waiting... (${ELAPSED}s / ${MAX_WAIT}s)"
done

if [ $ELAPSED -ge $MAX_WAIT ]; then
  echo "ERROR: Setup did not complete within ${MAX_WAIT}s."
  echo "Check logs with: gcloud compute ssh ${BUILDER_VM} --project=${PROJECT} --zone=${ZONE} --command='cat /var/log/moltshell-image-setup.log'"
  echo "Cleaning up..."
  gcloud compute instances delete "${BUILDER_VM}" --project="${PROJECT}" --zone="${ZONE}" --quiet 2>/dev/null || true
  exit 1
fi

# --- Step 3: Stop the VM ---
echo ""
echo "[3/6] Stopping VM..."
gcloud compute instances stop "${BUILDER_VM}" \
  --project="${PROJECT}" \
  --zone="${ZONE}" \
  --quiet

# --- Step 4: Create image from disk ---
echo ""
echo "[4/6] Creating image '${IMAGE_NAME}' in family '${IMAGE_FAMILY}'..."
gcloud compute images create "${IMAGE_NAME}" \
  --project="${PROJECT}" \
  --source-disk="${BUILDER_VM}" \
  --source-disk-zone="${ZONE}" \
  --family="${IMAGE_FAMILY}" \
  --description="MoltShell base image ${VERSION} - Node.js 22, tmux, nginx, tsx, systemd service"

# --- Step 5: Delete temp VM ---
echo ""
echo "[5/6] Deleting temp VM '${BUILDER_VM}'..."
gcloud compute instances delete "${BUILDER_VM}" \
  --project="${PROJECT}" \
  --zone="${ZONE}" \
  --quiet

# --- Step 6: Done ---
echo ""
echo "[6/6] Success!"
echo ""
echo "Image created: ${IMAGE_NAME}"
echo "Image family:  ${IMAGE_FAMILY}"
echo "Project:       ${PROJECT}"
echo ""
echo "Use in provisioner with:"
echo "  --image-family=${IMAGE_FAMILY} --image-project=${PROJECT}"
