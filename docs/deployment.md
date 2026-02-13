# Deployment Guide

This guide covers installing and running Meridian across all supported target environments.

## Target Environments

| Environment | RAM | Storage | CPU | Recommended Install |
|-------------|-----|---------|-----|---------------------|
| Laptop / Desktop | 8+ GB | 50+ GB SSD | Any | Clone + npm |
| Mac Mini / Home Server | 8-16 GB | 256+ GB SSD | Apple Silicon / x64 | Install script or Docker |
| Linux VPS | 2-4 GB | 40+ GB SSD | x64 | Docker Compose |
| Raspberry Pi 4/5 | 4-8 GB | 32+ GB SSD | ARM64 | Install script (no Docker) |

## Prerequisites

- **Node.js 20+** (for native install)
- **Docker 24+** and **Docker Compose v2** (for container install)
- **Build tools** (Linux native install): `python3`, `make`, `g++` for native modules (`better-sqlite3`, `argon2`)

## Installation Methods

### 1. Laptop / Desktop (Development)

```bash
git clone https://github.com/meridian/meridian.git
cd meridian
npm install
npm run build
npm run build:ui
npm run dev
```

Open http://127.0.0.1:3000 to access the Bridge UI.

### 2. Mac Mini / Home Server

**Option A: Install script**

```bash
curl -fsSL https://meridian.dev/install.sh | bash
```

**Option B: Docker Compose**

```bash
# Download the compose file
mkdir meridian && cd meridian
curl -fsSL https://meridian.dev/docker-compose.yml -o docker-compose.yml

# Generate a master key
openssl rand -hex 32 > master_key.txt

# Start
docker compose up -d
```

### 3. Linux VPS (Docker Compose — Recommended)

```bash
# Download the compose file
mkdir meridian && cd meridian
curl -fsSL https://meridian.dev/docker-compose.yml -o docker-compose.yml

# Generate a master key
openssl rand -hex 32 > master_key.txt

# Start
docker compose up -d
```

To include the optional SearXNG search engine:

```bash
docker compose --profile search up -d
```

### 4. Raspberry Pi

The install script auto-detects Raspberry Pi hardware and configures appropriate resource limits.

```bash
curl -fsSL https://meridian.dev/install.sh | bash
```

Docker is **not recommended** on Raspberry Pi due to overhead. The install script uses native Node.js with systemd.

**Important notes for Raspberry Pi:**

- **4 GB model**: Only viable without local Ollama. Use API-based embeddings (`embedding_provider = "openai"` or `"anthropic"` in config.toml). Ollama requires 8 GB minimum.
- **Storage**: USB SSD is strongly recommended over SD card. SD cards deliver 0.5-2 MB/s random write throughput vs 200-300 MB/s for SSD — a 100-600x difference. The setup wizard warns about SD card usage.
- **Node.js flags**: Automatically set by the install script:
  - Pi 4 GB: `--max-old-space-size=512 --optimize-for-size`
  - Pi 8 GB: `--max-old-space-size=1024`

## Configuration

### Config File

Meridian loads configuration from `data/config.toml`. See `docs/config.example.toml` for the full reference with all options documented.

Configuration precedence (highest wins):
1. Defaults (baked into application)
2. Config file (`data/config.toml`)
3. Environment variables (`MERIDIAN_*` prefix)
4. UI settings (stored in the database config table)

### Environment Variables

All configuration options can be overridden via environment variables with the `MERIDIAN_` prefix. This is the recommended approach for Docker deployments.

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `MERIDIAN_TIER` | string | auto-detected | Deployment tier: `pi`, `desktop`, `vps` |
| `MERIDIAN_DATA_DIR` | string | `data/` | Path to persistent data directory |
| `MERIDIAN_WORKSPACE_DIR` | string | `workspace/` | Path to Gear file workspace |
| `MERIDIAN_MASTER_KEY_FILE` | string | — | Path to master encryption key file |
| `MERIDIAN_NODE_FLAGS` | string | `--max-old-space-size=2048` | Node.js runtime flags (see tier-specific values below) |
| `MERIDIAN_AXIS_WORKERS` | number | 4 (2 on Pi) | Concurrent job workers |
| `MERIDIAN_AXIS_JOB_TIMEOUT_MS` | number | 300000 | Job timeout in milliseconds |
| `MERIDIAN_SCOUT_PROVIDER` | string | `anthropic` | Scout LLM provider |
| `MERIDIAN_SCOUT_MAX_CONTEXT_TOKENS` | number | 100000 | Scout max context tokens |
| `MERIDIAN_SCOUT_TEMPERATURE` | number | 0.3 | Scout LLM temperature |
| `MERIDIAN_SCOUT_MODELS_PRIMARY` | string | `claude-sonnet-4-5-20250929` | Primary planning model |
| `MERIDIAN_SCOUT_MODELS_SECONDARY` | string | `claude-haiku-4-5-20251001` | Secondary model |
| `MERIDIAN_SENTINEL_PROVIDER` | string | `openai` | Sentinel LLM provider |
| `MERIDIAN_SENTINEL_MODEL` | string | `gpt-4o` | Sentinel model |
| `MERIDIAN_SENTINEL_MAX_CONTEXT_TOKENS` | number | 32000 | Sentinel max context tokens |
| `MERIDIAN_JOURNAL_EMBEDDING_PROVIDER` | string | `local` | Embedding provider |
| `MERIDIAN_JOURNAL_EMBEDDING_MODEL` | string | `nomic-embed-text` | Embedding model |
| `MERIDIAN_JOURNAL_EPISODE_RETENTION_DAYS` | number | 90 | Episode retention in days |
| `MERIDIAN_JOURNAL_REFLECTION_ENABLED` | boolean | `true` | Enable reflection pipeline |
| `MERIDIAN_BRIDGE_BIND` | string | `127.0.0.1` | Bridge bind address |
| `MERIDIAN_BRIDGE_PORT` | number | 3000 | Bridge port |
| `MERIDIAN_BRIDGE_SESSION_DURATION_HOURS` | number | 168 | Session duration in hours |
| `MERIDIAN_SECURITY_DAILY_COST_LIMIT_USD` | number | 5.00 | Daily LLM cost limit |
| `MERIDIAN_SECURITY_REQUIRE_APPROVAL_FOR` | string[] | `file.delete,...` | Actions requiring approval (comma-separated) |

### Node.js Memory Flags by Tier

| Tier | Node.js Flags |
|------|---------------|
| Desktop / Mac Mini / VPS | `--max-old-space-size=2048` |
| Raspberry Pi 8 GB | `--max-old-space-size=1024` |
| Raspberry Pi 4 GB | `--max-old-space-size=512 --optimize-for-size` |

## Docker Configuration

### Security

The Docker setup includes these security hardening measures:

- **`no-new-privileges`**: Prevents privilege escalation inside the container
- **`read_only: true`**: Root filesystem is read-only; writes only to mounted volumes and tmpfs
- **`tmpfs: /tmp`**: Temporary files go to a memory-backed filesystem (256 MB limit)
- **Non-root user**: Meridian runs as UID 1001 inside the container
- **Localhost port binding**: `127.0.0.1:3000:3000` — not exposed to the network by default
- **Docker secrets**: Master key is mounted via Docker secrets, not environment variables

### Volumes

| Volume | Mount Point | Purpose |
|--------|-------------|---------|
| `meridian-data` | `/data` | Databases (meridian.db, journal.db, sentinel.db, audit logs), config, vault |
| `meridian-workspace` | `/workspace` | File workspace for Gear operations |
| `searxng-data` | `/etc/searxng` | SearXNG configuration (only with `--profile search`) |

### Custom Tier for Docker

To run with Raspberry Pi memory limits in Docker:

```bash
MERIDIAN_NODE_FLAGS="--max-old-space-size=1024" docker compose up -d
```

Or add to `docker-compose.override.yml`:

```yaml
services:
  meridian:
    environment:
      - MERIDIAN_NODE_FLAGS=--max-old-space-size=1024
      - MERIDIAN_TIER=pi
```

## Remote Access

By default, Meridian only binds to `127.0.0.1`. For remote access:

1. **Reverse proxy with TLS** (recommended): Use nginx, Caddy, or similar with HTTPS termination
2. **SSH tunnel**: `ssh -L 3000:127.0.0.1:3000 user@server`

**Never expose Meridian directly to the internet without TLS.** Authentication is mandatory on all deployments, but TLS is required to protect credentials in transit.

## Updating

Meridian does not check for updates automatically (no telemetry, no background network calls).

```bash
# Check for available updates
meridian update --check

# Apply update (backs up current version first)
meridian update

# Rollback to previous version if needed
meridian rollback
```

Database migrations run automatically after binary update, with a pre-migration backup.

## Troubleshooting

### Native Module Build Failures

If `npm install` fails on `better-sqlite3` or `argon2`:

```bash
# Debian/Ubuntu
sudo apt-get install -y python3 make g++

# macOS (Xcode command line tools)
xcode-select --install
```

### Permission Denied on Data Directory

```bash
sudo chown -R $(whoami) /opt/meridian/data
```

### Docker: Container Exits Immediately

Check logs:

```bash
docker compose logs meridian
```

Common causes:
- Missing `master_key.txt` — generate with `openssl rand -hex 32 > master_key.txt`
- Port 3000 already in use — change with `MERIDIAN_BRIDGE_PORT=3001`

### Raspberry Pi: Out of Memory

- Reduce workers: `MERIDIAN_AXIS_WORKERS=1`
- Disable local embeddings: set `embedding_provider = "openai"` in config.toml
- Ensure no Ollama process is running if on 4 GB model
