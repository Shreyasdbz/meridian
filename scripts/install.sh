#!/usr/bin/env bash
# Meridian — Installation script for Mac Mini, Linux servers, and Raspberry Pi
# Usage: curl -fsSL https://meridian.dev/install.sh | bash
#        or: bash scripts/install.sh
#
# This script:
#   1. Detects the platform and architecture
#   2. Verifies prerequisites (Node.js 20+, npm)
#   3. Installs Meridian from npm or from a local clone
#   4. Creates the data directory structure
#   5. Generates a master key for secret encryption
#   6. Writes a default config.toml
#   7. Optionally sets up a systemd service (Linux only)

set -euo pipefail

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

MERIDIAN_VERSION="${MERIDIAN_VERSION:-latest}"
INSTALL_DIR="${MERIDIAN_INSTALL_DIR:-/opt/meridian}"
DATA_DIR="${MERIDIAN_DATA_DIR:-/opt/meridian/data}"
MIN_NODE_MAJOR=20

# Colors (disabled if not a terminal)
if [ -t 1 ]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  BLUE='\033[0;34m'
  NC='\033[0m'
else
  RED='' GREEN='' YELLOW='' BLUE='' NC=''
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

info()  { printf "${BLUE}[info]${NC}  %s\n" "$*"; }
ok()    { printf "${GREEN}[ok]${NC}    %s\n" "$*"; }
warn()  { printf "${YELLOW}[warn]${NC}  %s\n" "$*"; }
error() { printf "${RED}[error]${NC} %s\n" "$*" >&2; }
fatal() { error "$@"; exit 1; }

command_exists() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------------------
# Platform detection
# ---------------------------------------------------------------------------

detect_platform() {
  OS="$(uname -s)"
  ARCH="$(uname -m)"

  case "$OS" in
    Linux)  PLATFORM="linux" ;;
    Darwin) PLATFORM="macos" ;;
    *)      fatal "Unsupported operating system: $OS" ;;
  esac

  case "$ARCH" in
    x86_64|amd64)   ARCH_NAME="x64" ;;
    aarch64|arm64)   ARCH_NAME="arm64" ;;
    armv7l)          ARCH_NAME="arm" ;;
    *)               fatal "Unsupported architecture: $ARCH" ;;
  esac

  # Detect Raspberry Pi
  IS_RPI=false
  if [ "$PLATFORM" = "linux" ] && [ -f /proc/device-tree/model ]; then
    if grep -qi "raspberry pi" /proc/device-tree/model 2>/dev/null; then
      IS_RPI=true
    fi
  fi

  # Detect total memory (MB)
  if [ "$PLATFORM" = "linux" ]; then
    TOTAL_MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
  elif [ "$PLATFORM" = "macos" ]; then
    TOTAL_MEM_MB=$(( $(sysctl -n hw.memsize) / 1024 / 1024 ))
  fi

  # Determine deployment tier
  # Only actual Raspberry Pi hardware gets the "pi" tier. Other ARM64 devices
  # (Apple Silicon Mac Mini, ARM VPS) use the desktop tier.
  if [ "$IS_RPI" = true ] && [ "$TOTAL_MEM_MB" -lt 5000 ]; then
    TIER="pi"
    NODE_FLAGS="--max-old-space-size=512 --optimize-for-size"
    info "Detected: Raspberry Pi (~${TOTAL_MEM_MB} MB RAM) — using pi tier"
    warn "RPi 4 GB is only viable without local Ollama. Ollama requires 8 GB."
  elif [ "$IS_RPI" = true ]; then
    TIER="pi"
    NODE_FLAGS="--max-old-space-size=1024"
    info "Detected: Raspberry Pi (~${TOTAL_MEM_MB} MB RAM) — using pi tier"
  else
    TIER="desktop"
    NODE_FLAGS="--max-old-space-size=2048"
    info "Detected: ${PLATFORM}/${ARCH_NAME} (~${TOTAL_MEM_MB} MB RAM) — using desktop tier"
  fi

  # Storage warning
  if [ "$IS_RPI" = true ] && [ "$PLATFORM" = "linux" ]; then
    ROOT_DEV=$(df / | tail -1 | awk '{print $1}')
    if echo "$ROOT_DEV" | grep -q "mmcblk"; then
      warn "Root filesystem is on an SD card. SSD is strongly recommended for"
      warn "better performance and longevity. See docs/deployment.md for details."
    fi
  fi
}

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------

check_prerequisites() {
  info "Checking prerequisites..."

  # Node.js
  if ! command_exists node; then
    error "Node.js is not installed."
    info "Install Node.js ${MIN_NODE_MAJOR}+ from https://nodejs.org/"
    if [ "$PLATFORM" = "linux" ]; then
      info "  Or: curl -fsSL https://deb.nodesource.com/setup_${MIN_NODE_MAJOR}.x | sudo -E bash -"
      info "      sudo apt-get install -y nodejs"
    elif [ "$PLATFORM" = "macos" ]; then
      info "  Or: brew install node@${MIN_NODE_MAJOR}"
    fi
    fatal "Cannot continue without Node.js."
  fi

  NODE_VERSION=$(node -v | sed 's/^v//')
  NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
  if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]; then
    fatal "Node.js ${MIN_NODE_MAJOR}+ required, found v${NODE_VERSION}"
  fi
  ok "Node.js v${NODE_VERSION}"

  # npm
  if ! command_exists npm; then
    fatal "npm is not installed (should come with Node.js)"
  fi
  ok "npm $(npm -v)"

  # Build tools for native modules
  if [ "$PLATFORM" = "linux" ]; then
    local missing=""
    command_exists python3 || missing="python3 $missing"
    command_exists make    || missing="make $missing"
    command_exists g++     || missing="g++ $missing"

    if [ -n "$missing" ]; then
      warn "Missing build tools: $missing"
      info "Native modules (better-sqlite3, argon2) require build tools."
      info "Install with: sudo apt-get install -y python3 make g++"
      fatal "Cannot continue without build tools."
    fi
    ok "Build tools available"
  fi
}

# ---------------------------------------------------------------------------
# Installation
# ---------------------------------------------------------------------------

install_meridian() {
  info "Installing Meridian to ${INSTALL_DIR}..."

  # Create install directory (atomic ownership assignment)
  if [ ! -d "$INSTALL_DIR" ]; then
    sudo install -d -o "$(whoami)" -g "$(id -gn)" "$INSTALL_DIR"
  fi

  # Check if we're running from a git clone
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  if [ -f "${SCRIPT_DIR}/../package.json" ]; then
    info "Installing from local source..."
    cd "${SCRIPT_DIR}/.."
    npm ci
    npm run build
    npm run build:ui

    if [ "$(pwd)" != "$INSTALL_DIR" ]; then
      cp -r dist node_modules package.json "$INSTALL_DIR/"
    fi
  else
    info "Installing from npm..."
    cd "$INSTALL_DIR"
    npm init -y >/dev/null 2>&1
    npm install "meridian@${MERIDIAN_VERSION}"
  fi

  ok "Meridian installed"
}

# ---------------------------------------------------------------------------
# Data directory setup
# ---------------------------------------------------------------------------

setup_data_dir() {
  info "Setting up data directory at ${DATA_DIR}..."

  mkdir -p "$DATA_DIR"
  mkdir -p "${INSTALL_DIR}/workspace"

  # Generate master key if not present
  if [ ! -f "${DATA_DIR}/master_key.txt" ]; then
    info "Generating encryption master key..."
    openssl rand -hex 32 > "${DATA_DIR}/master_key.txt"
    chmod 600 "${DATA_DIR}/master_key.txt"
    ok "Master key generated at ${DATA_DIR}/master_key.txt"
    warn "Back up this key! Without it, encrypted secrets cannot be recovered."
  else
    ok "Master key already exists"
  fi

  # Write default config.toml if not present
  if [ ! -f "${DATA_DIR}/config.toml" ]; then
    info "Writing default config.toml..."

    local workers=4
    if [ "$TIER" = "pi" ]; then
      workers=2
    fi

    cat > "${DATA_DIR}/config.toml" << TOML
# Meridian configuration
# See docs/deployment.md for full option reference.
# Precedence: defaults < this file < environment variables < UI settings

[axis]
workers = ${workers}
job_timeout_ms = 300000              # 5 minutes

[scout]
provider = "anthropic"               # anthropic | openai | google | ollama | openrouter
max_context_tokens = 100000
temperature = 0.3

[scout.models]
primary = "claude-sonnet-4-5-20250929"
secondary = "claude-haiku-4-5-20251001"

[sentinel]
provider = "openai"                  # Use a different provider from Scout for independence
model = "gpt-4o"
max_context_tokens = 32000

[journal]
embedding_provider = "local"         # "local" (Ollama) | "openai" | "anthropic"
embedding_model = "nomic-embed-text"
episode_retention_days = 90
reflection_enabled = true

[bridge]
bind = "127.0.0.1"                   # Localhost only — see docs/deployment.md for remote access
port = 3000
session_duration_hours = 168         # 7 days

[security]
daily_cost_limit_usd = 5.00
require_approval_for = ["file.delete", "shell.execute", "network.post", "message.send"]
TOML

    ok "Default config.toml written to ${DATA_DIR}/config.toml"
  else
    ok "config.toml already exists"
  fi
}

# ---------------------------------------------------------------------------
# Systemd service (Linux only)
# ---------------------------------------------------------------------------

setup_systemd_service() {
  if [ "$PLATFORM" != "linux" ]; then
    return
  fi

  if ! command_exists systemctl; then
    info "systemd not available — skipping service setup."
    info "Start Meridian manually: node ${NODE_FLAGS} ${INSTALL_DIR}/dist/index.js"
    return
  fi

  info "Setting up systemd service..."

  local service_user
  service_user="$(whoami)"

  sudo tee /etc/systemd/system/meridian.service > /dev/null << EOF
[Unit]
Description=Meridian AI Assistant
After=network.target

[Service]
Type=simple
User=${service_user}
WorkingDirectory=${INSTALL_DIR}
ExecStart=/usr/bin/node ${NODE_FLAGS} ${INSTALL_DIR}/dist/index.js
Restart=on-failure
RestartSec=5
Environment=MERIDIAN_DATA_DIR=${DATA_DIR}
Environment=MERIDIAN_WORKSPACE_DIR=${INSTALL_DIR}/workspace
Environment=MERIDIAN_TIER=${TIER}
Environment=MERIDIAN_MASTER_KEY_FILE=${DATA_DIR}/master_key.txt

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${DATA_DIR} ${INSTALL_DIR}/workspace
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

  sudo systemctl daemon-reload
  ok "Systemd service created"
  info "Enable with: sudo systemctl enable meridian"
  info "Start with:  sudo systemctl start meridian"
  info "Logs:        journalctl -u meridian -f"
}

# ---------------------------------------------------------------------------
# macOS launchd plist (optional)
# ---------------------------------------------------------------------------

setup_launchd_service() {
  if [ "$PLATFORM" != "macos" ]; then
    return
  fi

  local plist_dir="${HOME}/Library/LaunchAgents"
  local plist_path="${plist_dir}/dev.meridian.plist"

  info "To run Meridian as a background service on macOS, create a launchd plist:"
  info "  ${plist_path}"
  info ""
  info "Start manually with:"
  info "  node ${NODE_FLAGS} ${INSTALL_DIR}/dist/index.js"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  printf "\n"
  printf "${BLUE}╔══════════════════════════════════════╗${NC}\n"
  printf "${BLUE}║${NC}    Meridian Installation Script      ${BLUE}║${NC}\n"
  printf "${BLUE}╚══════════════════════════════════════╝${NC}\n"
  printf "\n"

  detect_platform
  check_prerequisites
  install_meridian
  setup_data_dir

  if [ "$PLATFORM" = "linux" ]; then
    setup_systemd_service
  else
    setup_launchd_service
  fi

  printf "\n"
  ok "Meridian installation complete!"
  printf "\n"
  info "Next steps:"
  info "  1. Edit config: ${DATA_DIR}/config.toml"
  info "  2. Add your LLM API keys through the Bridge UI"
  if [ "$PLATFORM" = "linux" ] && command_exists systemctl; then
    info "  3. Start: sudo systemctl start meridian"
    info "  4. Open: http://127.0.0.1:3000"
  else
    info "  3. Start: node ${NODE_FLAGS} ${INSTALL_DIR}/dist/index.js"
    info "  4. Open: http://127.0.0.1:3000"
  fi
  printf "\n"
}

main "$@"
