#!/bin/bash
set -euo pipefail

# Deploy MoltShell terminal server to GCS for VM self-update.
# Usage: ./scripts/deploy-to-gcs.sh

BUCKET="moltshell-releases"

echo "=== Deploying terminal server to gs://${BUCKET}/ ==="

# --- Step 1: Create temp directory and copy files ---
echo ""
echo "[1/4] Preparing release files..."
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

cp -r server/ "${TMPDIR}/server/"
cp package.json "${TMPDIR}/package.json"
cp package-lock.json "${TMPDIR}/package-lock.json"

# --- Step 2: Create tarball ---
echo ""
echo "[2/4] Creating tarball..."
tar -czf "${TMPDIR}/app.tar.gz" -C "${TMPDIR}" server/ package.json package-lock.json

# --- Step 3: Compute version hash ---
echo ""
echo "[3/4] Computing version hash..."
VERSION_HASH=$(sha256sum "${TMPDIR}/app.tar.gz" | awk '{print $1}')
echo "${VERSION_HASH}" > "${TMPDIR}/latest-version.txt"
echo "Version: ${VERSION_HASH}"

# --- Step 4: Upload to GCS ---
echo ""
echo "[4/4] Uploading to gs://${BUCKET}/..."
gsutil cp "${TMPDIR}/app.tar.gz" "gs://${BUCKET}/app.tar.gz"
gsutil cp "${TMPDIR}/latest-version.txt" "gs://${BUCKET}/latest-version.txt"

echo ""
echo "=== Deploy complete ==="
echo "Version:  ${VERSION_HASH}"
echo "Tarball:  gs://${BUCKET}/app.tar.gz"
echo "Version:  gs://${BUCKET}/latest-version.txt"
echo ""
echo "VMs will pick up the update on next WebSocket connection (within 5 min)."
