# Architecture Patches: Performance Engineer Review

> **Source**: `docs/critics/performance-engineer.md`
> **Target**: `docs/architecture.md` (v1.2)
> **Date**: 2026-02-08

Each patch below identifies a specific section to modify, the rationale from the review, and the proposed text changes. Patches are ordered by severity (P1 Critical > P2 Serious > P3 Concern) then by section number.

---

## Patch 1: Move SQLite Operations to a Dedicated Worker Thread

**Severity**: P1 - Critical
**Review Finding**: #9 (Streaming Performance), #5 (Worker Pool Serialization), #12.2 (Missing Performance Infrastructure)
**Target Section**: 14.1 (Core Technologies), 5.1.1 (Axis Responsibilities)

### Rationale

`better-sqlite3` is synchronous by design. Every `.run()`, `.get()`, `.all()` call blocks the Node.js event loop until the SQLite operation completes. On an SD card, a simple INSERT takes 1-5ms, an FTS5 insert trigger takes 5-20ms, and a WAL checkpoint takes 50-200ms. During these operations, no WebSocket messages are sent, no HTTP responses go out, and LLM streaming tokens accumulate in Node.js internal buffers. This causes visible "stuttering" in the Bridge UI when Scout is streaming a response while Journal is simultaneously writing episodic memory. This is the single highest-impact performance fix in the architecture. The reviewer rates this non-negotiable for streaming performance.

### Changes

**14.1 -- Amend the Database row in the Core Technologies table:**

Current:
> | Database | SQLite (via `better-sqlite3`) | No daemon, zero config, single-file, WAL mode for concurrency |

Proposed:
> | Database | SQLite (via `better-sqlite3`) | No daemon, zero config, single-file, WAL mode for concurrency. All database operations run in a dedicated worker thread to avoid blocking the event loop. |

**14.1 -- Add after the Core Technologies table:**

```markdown
#### 14.1.1 SQLite Worker Thread Architecture

`better-sqlite3` is synchronous -- every database call blocks the calling thread until the
operation completes. For indexed lookups this is negligible (microseconds), but several
operations block for durations that cause user-visible degradation:

| Operation | Typical Duration (SSD) | Typical Duration (SD card) | Impact |
|-----------|----------------------|---------------------------|--------|
| Simple INSERT | < 1 ms | 1-5 ms | Negligible |
| FTS5 insert trigger | 1-3 ms | 5-20 ms | Barely perceptible |
| WAL checkpoint | 5-20 ms | 50-200 ms | Streaming stutter |
| FTS5 segment merge | 10-50 ms | 50-500 ms | Visible UI freeze |
| Full VACUUM | 100+ ms | 1-10 seconds | Must not run on main thread |

**Solution:** All SQLite operations run in a dedicated `worker_threads` worker. The main
event loop communicates with the database worker via `MessagePort`:

```
Main Thread (event loop)              Database Worker Thread
├── HTTP/WS handling                  ├── better-sqlite3 connections (all DBs)
├── LLM stream processing             ├── Executes all SQL operations
├── Inter-component routing           ├── Returns results via MessagePort
└── Never touches SQLite directly     └── Handles VACUUM, FTS rebuild, ANALYZE
```

**API pattern:** The `@meridian/shared` package exports an async database client that wraps
the synchronous `better-sqlite3` calls in worker thread message passing:

```typescript
// Main thread -- non-blocking
const result = await db.get<Job>('SELECT * FROM jobs WHERE id = ?', [jobId]);

// Worker thread -- synchronous better-sqlite3, but isolated from event loop
```

This approach is well-established in the `better-sqlite3` community and documented in the
library's own recommendations for server applications. The async overhead per call is
~0.05-0.1ms (MessagePort serialization), negligible compared to the blocking risk.

**Read and write connections:** Each database opens two connections in the worker thread:
- A write connection for INSERT, UPDATE, DELETE, and DDL.
- A read connection opened with `readonly: true`.

WAL mode ensures write transactions do not block reads. The read connection handles all
query operations (job status lookups, memory retrieval, audit queries).
```

**5.1.1 -- Amend the Axis responsibilities list, add:**

```markdown
- Manage the database worker thread lifecycle (startup, health monitoring, graceful shutdown)
```

---

## Patch 2: Publish a Tested Memory Budget for Raspberry Pi

**Severity**: P1 - Critical
**Review Finding**: #1 (Memory Budget), #12.3 (Missing Memory Budget Per Component)
**Target Section**: 11.2 (Resource Management on Constrained Devices)

### Rationale

The Raspberry Pi 4 with 4GB RAM is stated as the primary target, but the performance section (Section 11) is 42 lines in a 2,077-line document. The reviewer provides a detailed memory budget showing that running Ollama for local embeddings simultaneously with Gear execution is not practically feasible on a 4GB Pi. The current "Raspberry Pi Optimizations" section is too vague. Explicit memory budgets with enforcement mechanisms are needed.

### Changes

**11.2 -- Replace the existing "Raspberry Pi Optimizations" section with:**

```markdown
#### Raspberry Pi Optimizations

**Memory budget:** The 4GB Raspberry Pi 4 is the primary constrained target. After the OS
and kernel consume ~600 MB, approximately 3.4 GB remains for Meridian. The following budget
allocates this headroom with margin for spikes:

| Component | Budget (4GB Pi) | Budget (8GB Pi) | Enforcement Mechanism |
|-----------|----------------|-----------------|----------------------|
| OS + kernel + services | ~600 MB | ~600 MB | System (unavoidable) |
| Node.js V8 heap | 512 MB | 1024 MB | `--max-old-space-size` |
| SQLite page caches (all DBs) | 160 MB | 400 MB | `PRAGMA cache_size` per DB |
| Gear sandbox (all concurrent) | 300 MB | 600 MB | Isolate `memoryLimit` or cgroup |
| LLM provider SDK connections | 20 MB | 20 MB | Connection limits |
| Streaming + logging buffers | 20 MB | 40 MB | Application-level limits |
| Ollama (if running locally) | 0 MB (API mode) | 800 MB | Ollama `OLLAMA_KEEP_ALIVE` |
| Headroom for spikes | ~400 MB | ~500 MB+ | Memory watchdog |
| **Total** | **~2,012 MB** | **~3,984 MB** | |

**Critical constraint on 4GB Pi:** Running Ollama for local embeddings simultaneously with
Gear execution exceeds the memory budget. On 4GB Pi deployments:
- Default to API-based embeddings (OpenAI `text-embedding-3-small` or similar).
- If local embeddings are required, use `all-MiniLM-L6-v2` (not `nomic-embed-text`) and
  configure Ollama with `OLLAMA_KEEP_ALIVE=0` to unload the model immediately after each
  inference call.
- `nomic-embed-text` (137M parameters, 500-800 MB runtime) is only viable on 8GB+ devices.

**V8 heap limit:** The Node.js process MUST be started with an explicit heap cap:
- 4GB Pi: `--max-old-space-size=512`
- 8GB Pi: `--max-old-space-size=1024`
- Mac Mini / VPS: `--max-old-space-size=2048`

Without this, V8 auto-sizes based on available system memory and may attempt to use 1.5-2 GB
on a 4GB Pi, leaving no room for other components.

**Worker count:** Default to 2 concurrent job workers on Raspberry Pi (vs. 4 on Mac Mini,
8 on VPS).

**Embedding model:** Use API-based embeddings as the default for Pi. If local embeddings
are used, prefer `all-MiniLM-L6-v2` (22M parameters, ~150-250 MB runtime) over
`nomic-embed-text`.

**No container isolation by default:** Use process-level sandboxing to avoid Docker overhead.

**Memory monitoring:** Axis monitors system memory via `process.memoryUsage()` and
`os.freemem()` every 60 seconds. Non-critical jobs are paused if available system RAM drops
below 512 MB.

**Disk monitoring:** Alert when disk usage exceeds 80%. Pause non-critical operations at 90%.

**These budgets MUST be validated with measured numbers on real Pi 4 hardware before claiming
Pi 4 support.** Run the full system under realistic load (10 tasks/hour, mixed fast-path and
full-path, with concurrent scheduled jobs) for 24 hours and publish RSS measurements. If the
system cannot sustain this workload on 4GB, officially support 8GB Pi as the minimum.
```

---

## Patch 3: Recommend SSD Over SD Card for Storage

**Severity**: P1 - Critical
**Review Finding**: #2 (SQLite Under Load: I/O Profile on SD Cards)
**Target Section**: 10.1 (Target Environments), 11.2 (Resource Management)

### Rationale

A typical SD card has 0.5-2 MB/s random write speed vs. 200-300 MB/s for a USB 3.0 SSD -- a 100-600x difference. With 4+ WAL databases, FTS5 segment merges, vector search, and daily backups, SD card I/O is a fundamental bottleneck that causes visible application pauses and reduces card lifespan. The current deployment table says "32+ GB SD/SSD" with no preference stated.

### Changes

**10.1 -- Amend the Raspberry Pi row in the Target Environments table:**

Current:
> | Raspberry Pi 4/5 | 4-8 GB | 32+ GB SD/SSD | ARM64 | Primary target. Docker optional. |

Proposed:
> | Raspberry Pi 4/5 | 4-8 GB | 32+ GB SSD (recommended) or SD card (limited) | ARM64 | Primary target. Docker optional. SSD via USB 3.0 strongly recommended for performance and longevity. |

**10.2 -- Add a note after the installation options:**

```markdown
**Storage recommendation for Raspberry Pi:** A USB 3.0 SSD ($15-25) is strongly recommended
over an SD card for the data directory. Performance comparison:

| Metric | SD Card (Class 10) | USB 3.0 SSD |
|--------|--------------------|-------------|
| Sequential read | 20-40 MB/s | 300-400 MB/s |
| Sequential write | 15-30 MB/s | 200-300 MB/s |
| Random read (4K) | 1-3 MB/s | 30-50 MB/s |
| Random write (4K) | 0.5-2 MB/s | 20-40 MB/s |
| Write endurance | 5,000-10,000 P/E cycles | 600-3,000 TBW |

Meridian runs 4 SQLite databases in WAL mode with FTS5 indexes, generating an estimated
50-200 MB of writes per day under moderate use. On an SD card, this means:
- WAL checkpoint I/O blocks the event loop for 50-200ms (vs. 5-20ms on SSD).
- FTS5 segment merges cause visible application pauses.
- The SD card may degrade within 2-3 years of sustained use.

The setup wizard detects whether the data directory is on removable storage and warns the
user if so.

**If an SSD is not available:** Meridian works on SD cards but with degraded performance.
See Section 11.2 for SD card-specific tuning.
```

**11.2 -- Add under the Raspberry Pi Optimizations section:**

```markdown
**SD card I/O tuning (when SSD is unavailable):**
- Set `PRAGMA wal_autocheckpoint = 5000` (vs. default 1000 pages) to batch checkpoint writes
  and reduce random write amplification on flash storage.
- Stagger checkpoint timing: Axis triggers `PRAGMA wal_checkpoint(TRUNCATE)` for each database
  sequentially during idle periods, not simultaneously.
- Run FTS5 `optimize` only during idle maintenance windows, never during user-facing operations.
- Monitor WAL file sizes per database. Alert if any WAL exceeds 50 MB (suggesting checkpoints
  are falling behind).
- Reduce backup frequency to weekly (vs. daily) to preserve SD card write endurance.
```

---

## Patch 4: Clarify Gear Sandboxing Mechanism and Cap Concurrent Isolates

**Severity**: P1 - Critical
**Review Finding**: #3 (isolated-vm Overhead)
**Target Section**: 5.6.3 (Sandboxing Model), 14.1 (Core Technologies)

### Rationale

There is an architectural ambiguity: the tech stack (Section 14.1) lists `isolated-vm` for sandboxing, but Section 5.6.3 Level 1 describes "separate child processes with restricted permissions" + seccomp. These have very different performance profiles. A bare `isolated-vm` V8 isolate consumes 30-50 MB before any user code runs and takes 135-360ms to cold-start on a Pi 4. A child process with COW memory sharing costs ~10-15 MB. On a 4GB Pi, this difference determines whether 2 or 4 concurrent Gear executions are feasible. Additionally, if a plan has 3 parallel steps, 3 simultaneous isolates could exceed the safe memory limit on Pi.

### Changes

**5.6.3 -- Replace the existing sandboxing description with:**

```markdown
#### 5.6.3 Sandboxing Model

Gear execution is sandboxed to prevent untrusted code from accessing system resources beyond
its declared permissions. The sandboxing mechanism depends on the deployment environment:

**Level 1: Process Isolation (Default for Raspberry Pi and lightweight deployments)**

Gear runs as separate Node.js child processes (`child_process.fork()`) with OS-level
restrictions:

- Each Gear execution spawns a dedicated child process.
- Linux: `seccomp-bpf` filtering restricts available syscalls.
- macOS: `sandbox-exec` profiles restrict filesystem and network access.
- Filesystem access restricted to declared paths using bind mounts or symlinks.
- Network access restricted to declared domains using a local filtering proxy.
- Resource limits enforced via cgroups (Linux) or process resource limits (macOS).
- Child processes share memory pages with the parent via copy-on-write (COW), reducing
  per-process overhead to ~10-15 MB for simple Gear.

**Performance profile (Level 1 on Raspberry Pi 4):**

| Metric | Value |
|--------|-------|
| Per-process memory overhead | 10-15 MB (COW, before Gear code runs) |
| Cold start (fork + setup) | 50-150 ms |
| Max concurrent Gear processes | 4 (within memory budget) |

**Level 2: V8 Isolate Isolation (Optional, for environments needing stronger in-process isolation)**

For deployments that prefer in-process isolation without the overhead of full child processes,
Gear runs in `isolated-vm` V8 isolates:

- Dedicated V8 isolate per Gear execution with separate heap.
- No access to Node.js APIs (`require`, `process`, `fs` are unavailable).
- Data transfer between main isolate and Gear isolate is explicit and controlled.
- Memory limit enforced via `memoryLimit` option.

**Performance profile (Level 2 on Raspberry Pi 4):**

| Metric | Value |
|--------|-------|
| Per-isolate memory overhead | 30-50 MB (V8 infrastructure, before Gear code runs) |
| Cold start (create + compile) | 135-360 ms |
| Max concurrent isolates | 2 (within memory budget) |

**Caution:** `isolated-vm` isolate overhead is significantly higher than child process
isolation. On 4GB Pi, Level 2 limits concurrent Gear to 2 vs. 4 for Level 1. Level 2 is
recommended only when the deployment cannot use OS-level process restrictions (e.g., certain
container environments).

**Level 3: Container Isolation (Recommended for Docker-capable deployments)**

For deployments with Docker available, each Gear runs in a lightweight container:

- Dedicated container per Gear execution.
- Read-only root filesystem.
- No host network access; traffic routed through a filtered proxy.
- Resource limits enforced by Docker (memory, CPU, pids).
- Automatically destroyed after execution completes.

```
Axis -> creates container -> mounts workspace (read-only by default)
     -> injects declared secrets as env vars
     -> executes Gear action
     -> collects stdout/stderr as result
     -> destroys container
```

**Concurrency limits:** Regardless of sandboxing level, Axis enforces a maximum number of
concurrent Gear executions based on the deployment target:

| Target | Max Concurrent Gear | Enforcement |
|--------|-------------------|-------------|
| 4GB Raspberry Pi (Level 1) | 3 | Process count semaphore |
| 4GB Raspberry Pi (Level 2) | 2 | Isolate count semaphore |
| 8GB Raspberry Pi | 4 | Configurable |
| Mac Mini / VPS | 6-8 | Configurable |

If a job plan specifies more parallel steps than the concurrency limit allows, Axis
serializes the excess steps rather than exceeding the limit. This ensures memory safety
at the cost of throughput.

**Isolate/process pooling (optimization):** To avoid paying cold-start overhead on every
Gear execution, Axis maintains a warm pool of 2 sandbox instances (processes or isolates)
that are recycled between executions. After each execution, the sandbox state is reset
(process: new `fork()`; isolate: `dispose()` + create new). Security analysis is required
to verify that no residual state leaks between executions.
```

**14.1 -- Amend the Process Sandbox row in the Core Technologies table:**

Current:
> | Process Sandbox | `isolated-vm` + seccomp/sandbox-exec | Lightweight V8 isolate sandboxing (note: `vm2` is deprecated/archived due to unfixable escape CVEs -- do not use) |

Proposed:
> | Process Sandbox | `child_process.fork()` + seccomp/sandbox-exec (Level 1, default), `isolated-vm` (Level 2, optional), Docker (Level 3) | Level 1 uses OS-level process isolation with COW memory sharing (~10-15 MB/process). Level 2 uses V8 isolates (~30-50 MB/isolate). Level 3 uses containers. Note: `vm2` is deprecated/archived due to unfixable escape CVEs -- do not use. |

---

## Patch 5: Add Missing Performance Infrastructure

**Severity**: P1 - Critical
**Review Finding**: #12 (Missing: Critical Performance Infrastructure)
**Target Section**: 11 (Performance & Resource Management), 5.1.5 (Fault Tolerance)

### Rationale

The architecture is missing several pieces of performance infrastructure that are essential for a long-running daemon on constrained hardware: V8 garbage collection tuning, CPU profiling, a memory watchdog with graduated responses, connection pool sizing, request deadline propagation, and swap configuration guidance. These are collectively critical -- any one omission is manageable, but together they represent a gap in the system's ability to run reliably on a 4GB Pi.

### Changes

**11 -- Add new subsection 11.3 after 11.2:**

```markdown
### 11.3 Performance Infrastructure

These mechanisms are required for reliable operation as a long-running daemon on constrained
hardware.

#### 11.3.1 V8 Garbage Collection Tuning

Node.js V8 GC defaults are tuned for short-lived processes with ample memory. On a 4GB Pi
running a long-lived daemon, defaults are unsafe:

- **Default behavior**: V8 auto-sizes the old-space heap based on available system memory,
  potentially claiming 1.5-2 GB on a 4GB Pi.
- **GC pauses**: With a large heap (>512 MB), V8's major GC pauses can be 50-200 ms --
  freezing streaming, WebSocket, and HTTP during the pause.

**Required Node.js flags by deployment target:**

| Target | Flags |
|--------|-------|
| 4GB Raspberry Pi | `--max-old-space-size=512 --optimize-for-size` |
| 8GB Raspberry Pi | `--max-old-space-size=1024` |
| Mac Mini / VPS | `--max-old-space-size=2048` |

The `--optimize-for-size` flag on Pi trades execution speed for lower memory usage -- a
worthwhile tradeoff on constrained devices where memory pressure is the primary risk.

#### 11.3.2 Memory Watchdog

Axis runs a memory watchdog that samples `process.memoryUsage()` and `os.freemem()` every
60 seconds with a graduated response:

| Threshold | Response |
|-----------|----------|
| RSS > 70% of configured max | Log warning, emit metric |
| RSS > 80% of configured max | Trigger forced GC (`global.gc()` with `--expose-gc`), pause non-critical background tasks |
| RSS > 90% of configured max | Initiate graceful shutdown: stop accepting new jobs, wait for in-flight jobs (30s timeout), persist state, restart process |
| System free memory < 256 MB | Emergency: kill all Gear sandboxes, pause all jobs, notify user |

The watchdog also tracks:
- **Gear sandbox count**: If `(created - disposed) > expected_max`, log a leak warning.
- **Event loop lag**: Using `monitorEventLoopDelay()` from `perf_hooks`. Alert if the
  p99 event loop delay exceeds 50 ms (the 10-second watchdog in Section 5.1.5 catches
  catastrophic freezes; this catches performance degradation before it becomes visible).

#### 11.3.3 Event Loop Monitoring

The event loop is the single point of contention in Node.js. Meridian instruments event
loop health from day one:

- **`monitorEventLoopDelay()`** (from `perf_hooks`): Sampled continuously. Exposed as
  the `meridian_event_loop_delay_seconds` histogram metric.
- **Alert thresholds**: Warn at p99 > 50 ms. Error at p99 > 200 ms.
- **Diagnostic dump**: If the event loop is blocked for > 5 seconds (reduced from 10s
  in Section 5.1.5), Axis captures a diagnostic dump including: current stack trace,
  active handles/requests count, memory usage, and open file descriptors.

#### 11.3.4 CPU Profiling (On-Demand)

A lightweight profiling mechanism is available for diagnosing performance issues in
production:

- **Trigger**: Send `SIGUSR2` to the Meridian process.
- **Action**: Captures a 30-second CPU profile and writes it to `data/diagnostics/`.
  Also triggers `v8.writeHeapSnapshot()` for memory analysis.
- **Format**: V8 CPU profile (`.cpuprofile`) and heap snapshot (`.heapsnapshot`),
  viewable in Chrome DevTools.
- **Overhead**: < 5% CPU during the 30-second capture window.

#### 11.3.5 Connection Limits

| Resource | Limit (4GB Pi) | Limit (8GB+ / VPS) | Rationale |
|----------|---------------|--------------------|-----------|
| HTTP/2 connections to LLM providers | 2 concurrent | 4 concurrent | TLS state + buffers ~5-10 MB per connection |
| Ollama connections | 1 | 2 | Localhost HTTP, lightweight |
| Gear outbound connections (via proxy) | 5 concurrent | 10 concurrent | Each proxied connection holds buffers |
| WebSocket connections (Bridge) | 3 | 10 | Memory per connection ~0.5-2 MB |
| SQLite connections per database | 2 (1 read, 1 write) | 2 (1 read, 1 write) | WAL mode supports this |

#### 11.3.6 Request Deadline Propagation

Each Job carries a `deadlineMs` field that represents the total time budget from creation to
completion. As the job passes through each component, the remaining budget is decremented:

```
Job created with deadlineMs = 60000 (60 seconds)
  Scout planning takes 8s      -> remaining: 52000 ms
  Sentinel validation takes 3s -> remaining: 49000 ms
  Gear execution budget: 49000 ms (not the default 300000 ms)
```

If 80% of the deadline has elapsed before execution begins, Axis proactively notifies the
user via Bridge that the task is taking longer than expected.

If the remaining budget would be less than 5 seconds when entering a new phase, Axis skips
that phase (e.g., skips Journal reflection) to prioritize delivering a result to the user.

The per-step `timeoutMs` in the execution plan serves as an upper bound -- a step's timeout
is `min(step.timeoutMs, job.remainingDeadline)`.
```

**5.1.5 -- Amend the Watchdog description:**

Current:
> - **Watchdog**: A lightweight health check loop monitors Axis's own responsiveness. If the event loop is blocked for >10 seconds, Axis logs a warning and triggers a diagnostic dump.

Proposed:
> - **Watchdog**: A lightweight health check loop monitors Axis's own responsiveness. If the event loop is blocked for >5 seconds, Axis logs an error and triggers a diagnostic dump (stack trace, memory usage, active handles). Event loop delay is also continuously monitored via `monitorEventLoopDelay()` with alerts at p99 > 50 ms (see Section 11.3.3).

---

## Patch 6: Address sqlite-vec Brute-Force Search Scaling

**Severity**: P2 - Serious
**Review Finding**: #4 (Vector Search Performance)
**Target Section**: 5.4.5 (Retrieval: Hybrid Search), 11.1 (LLM API Optimization)

### Rationale

`sqlite-vec` performs brute-force kNN search (no approximate nearest neighbor indexing). At 10,000 vectors with 768 dimensions, a cold query from SD card takes 1.5-3 seconds. Even from memory (warm page cache), it takes 50-120ms on a Pi 4. After 90 days of active use, a user could have 5,000-10,000+ memory entries. The brute-force scan is on the critical path for every non-fast-path request.

### Changes

**5.4.5 -- Add after the existing hybrid search description:**

```markdown
**Vector search performance considerations:**

`sqlite-vec` uses brute-force kNN search (scanning all vectors to find top-k). Query time
scales linearly with vector count:

| Vector Count | Dimensions | Query Time (warm cache, Pi 4) | Query Time (cold, SD card) |
|-------------|------------|------------------------------|---------------------------|
| 1,000 | 768 | 5-15 ms | 200-400 ms |
| 5,000 | 768 | 25-60 ms | 800-1,500 ms |
| 10,000 | 768 | 50-120 ms | 1,500-3,000 ms |

**Mitigations (applied in order of impact):**

1. **Embedding cache**: Journal maintains an LRU cache keyed on content hash for recently
   computed embeddings. Queries similar to previous ones get a cache hit, avoiding both the
   embedding computation and a redundant vector search.

2. **Page cache pre-warming**: On startup, Journal runs a dummy vector query to pull the
   vector index into SQLite's page cache. This avoids the cold-from-storage penalty on the
   first real query.

3. **Dimensionality reduction**: For deployments with >5,000 vectors, Journal can store
   reduced-dimension vectors (e.g., PCA from 768 to 256 dimensions). This provides a ~3x
   reduction in scan time at a modest quality cost for retrieval. The full-dimension vectors
   are retained for re-ranking the top results.

4. **Vector count monitoring**: Journal tracks the total vector count. When it exceeds
   a configurable threshold (default: 10,000), the system surfaces a notification in Bridge
   recommending memory pruning or archival. Archived episodic memories have their vectors
   removed from the active search index.

5. **Tiered search**: For queries where recency is a strong signal, Journal searches only
   vectors from the last N days first. If results are insufficient (below relevance
   threshold), it falls back to a full scan.
```

---

## Patch 7: Add Phase-Aware Scheduling to Worker Pool

**Severity**: P2 - Serious
**Review Finding**: #5 (Worker Pool Concurrency Profile)
**Target Section**: 5.1.3 (Concurrency Model)

### Rationale

"2 workers" does not mean "2 things happening at once." Two jobs both in the Gear execution phase means 2 concurrent sandbox instances. Two jobs both writing to the same SQLite database serialize on the WAL write lock. The worker pool needs awareness of which phase each job is in to avoid resource conflicts and overcommitment.

### Changes

**5.1.3 -- Add after the existing Step Parallelism bullet:**

```markdown
- **Phase-aware scheduling**: Axis tracks the current phase of each in-flight job
  (`planning`, `validating`, `executing`, `reflecting`). Resource-intensive phases are
  constrained by semaphores independent of the worker pool size:

  | Resource | Semaphore | Default (4GB Pi) | Default (Mac Mini/VPS) |
  |----------|-----------|-----------------|----------------------|
  | Concurrent Gear executions | `gearSemaphore` | 2-3 | 6-8 |
  | Concurrent LLM API calls | `llmSemaphore` | 3 | 6 |
  | Concurrent Journal reflections | `reflectionSemaphore` | 1 | 2 |

  If a job enters the `executing` phase but the `gearSemaphore` is full, the job waits
  (with its deadline still ticking) rather than overcommitting memory. Other jobs in less
  resource-intensive phases (e.g., `planning`, which is mostly waiting on network I/O) can
  proceed.

  This means the worker pool size controls how many jobs are conceptually in-flight, while
  the phase semaphores control how many resource-intensive operations happen simultaneously.
```

---

## Patch 8: Address Memory Leak Vectors

**Severity**: P2 - Serious
**Review Finding**: #6 (Memory Leaks: Long-Running Process Risk)
**Target Section**: 5.1.5 (Fault Tolerance), 5.6.4 (Gear Lifecycle)

### Rationale

Meridian is a long-running daemon. On a 4GB Pi, there is zero headroom for memory leaks. The reviewer identifies five specific leak vectors: sandbox instances not properly disposed (30-50 MB each), unclean WebSocket disconnections, uncached prepared SQLite statements, event listener accumulation on the message bus, and unconsumed LLM streaming buffers. The architecture should specify defensive measures for each.

### Changes

**5.1.5 -- Add after the existing fault tolerance items:**

```markdown
- **Resource leak prevention**: As a long-running daemon on constrained hardware, Meridian
  implements defensive measures against known leak vectors:

  1. **Gear sandbox lifecycle**: Every sandbox instance (process or isolate) is tracked with
     a creation timestamp and a mandatory disposal deadline. If a sandbox is not disposed
     within `timeoutMs + 30 seconds` of creation, Axis force-kills it and logs a warning.
     The memory watchdog (Section 11.3.2) also alerts if outstanding sandbox count exceeds
     the expected maximum.

  2. **WebSocket connection hygiene**: Bridge configures `ws` with ping/pong heartbeat
     (30-second interval, 10-second timeout). Connections that fail the heartbeat are
     terminated and their buffers released. Reconnection logic in the Bridge frontend
     closes the previous connection before opening a new one.

  3. **Prepared statement caching**: All SQLite prepared statements are cached at the
     module level using a statement cache map, not prepared per-request. This prevents
     V8 GC pressure from accumulating native statement handles.

  4. **Event listener cleanup**: Job-scoped event listeners on the Axis message bus are
     registered with the job ID and automatically deregistered when the job reaches a
     terminal state (`completed`, `failed`, `cancelled`). Axis periodically audits
     listener counts and logs a warning if any event has more than 20 listeners.

  5. **LLM stream lifecycle**: All LLM streaming iterables (`AsyncIterable<ChatChunk>`)
     are wrapped with abort controllers. When a job is cancelled or a user disconnects
     mid-stream, the abort controller signals the HTTP/2 stream to close, releasing its
     internal buffers. Unconsumed streams are never left open.
```

---

## Patch 9: Improve Cold Start and First-Request Performance

**Severity**: P2 - Serious
**Review Finding**: #7 (Cold Start Time)
**Target Section**: 11.2 (Resource Management), 5.5 (Bridge)

### Rationale

The estimated cold start on Pi 4 is 2.5-6.2 seconds (excluding embedding model loading). The architecture says "lazy loading: components are loaded on first use" but this means the first user request pays the lazy-loading cost on top of any remaining startup work, potentially adding 8+ seconds if embedding model loading is triggered. The reviewer recommends eager loading of critical paths and a "warming up" indicator.

### Changes

**11.2 -- Add under the Raspberry Pi Optimizations section:**

```markdown
**Startup and cold start optimization:**

Target cold start time: **< 3 seconds on Pi 4 with SSD** (measured and tracked in CI).

| Phase | Target Time | Strategy |
|-------|-------------|----------|
| Node.js + module loading | < 800 ms | Use `tsup` to produce compact bundles |
| SQLite database opening (all DBs) | < 300 ms | Open eagerly at startup, not lazily |
| Schema migration check | < 200 ms | Read `schema_version` from each DB |
| Fastify + route registration | < 200 ms | Standard Fastify startup |
| Gear manifest validation | < 300 ms | Load manifests from disk |
| Job queue recovery | < 200 ms | Read pending jobs from `meridian.db` |
| **Total (without embedding model)** | **< 2,000 ms** | |

**Eager vs. lazy loading:**
- **Eager (at startup)**: SQLite databases, Fastify server, Gear manifests, cron schedules.
  These are fast to load and needed for any request.
- **Lazy (on first use)**: Ollama embedding model, LLM provider connections, sqlite-vec
  warm-up. These are slow but not needed until the first relevant request.

**Pre-warming (background, immediately after startup):**
After the server is listening and able to accept requests, a background task:
1. Runs a dummy FTS5 query on each database to warm the FTS segment cache.
2. Runs a dummy vector query against `memory_embeddings` to pull the vector index into
   the page cache.
3. Pre-fetches Ollama model metadata (but does NOT load model weights).
4. Establishes keep-alive connections to configured LLM providers.

This ensures the first real user request hits warm caches.
```

**5.5.1 -- Add to the Bridge responsibilities list:**

```markdown
- Display a "warming up" status indicator for the first few seconds after startup, so the
  user knows the system is not yet at full speed
```

---

## Patch 10: Add Embedding Model Migration Strategy

**Severity**: P2 - Serious
**Review Finding**: #10 (The Re-embedding Bomb)
**Target Section**: 5.4 (Journal), 8.3 (Schema Overview)

### Rationale

If a user changes embedding models (e.g., from `all-MiniLM-L6-v2` to `nomic-embed-text`, or from local to API provider), every stored vector becomes incompatible -- vectors from different models cannot be mixed in the same similarity search. After 90 days of use, the system could have 5,000-12,500 entries needing re-embedding. The architecture has no mention of embedding model versioning, migration, or re-embedding.

### Changes

**8.3 -- Amend the vector embeddings table in journal.db to include model metadata:**

Add a column to the vector embeddings schema (whether it is a separate `journal-vectors.db`
or merged into `journal.db` per the database engineer's Patch 4):

```sql
-- Vector embeddings for semantic search (sqlite-vec extension)
CREATE VIRTUAL TABLE memory_embeddings USING vec0(
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,           -- 'episodic' | 'semantic' | 'procedural'
  embedding FLOAT[768]                 -- Dimension set at creation time
);

-- Embedding metadata (tracks which model produced each vector)
CREATE TABLE embedding_metadata (
  id TEXT PRIMARY KEY,                 -- Same ID as memory_embeddings
  model_id TEXT NOT NULL,              -- e.g., 'nomic-embed-text-v1.5', 'text-embedding-3-small'
  model_dimensions INTEGER NOT NULL,   -- 768, 384, 1536, etc.
  created_at TEXT NOT NULL
);

CREATE INDEX idx_embedding_metadata_model ON embedding_metadata(model_id);
```

**5.4 -- Add new subsection 5.4.8 after 5.4.7:**

```markdown
#### 5.4.8 Embedding Model Migration

When the user changes the configured embedding model, existing vectors become incompatible
with new ones (different models produce vectors in different semantic spaces). Journal
handles this gracefully:

**Detection:** Every stored vector is tagged with its source `model_id` in the
`embedding_metadata` table. When the configured model changes, Journal knows exactly
which vectors are stale.

**Migration strategy: Background re-embedding with mixed-model queries.**

```
User changes embedding model
       |
       v
Journal marks all existing vectors as "stale" (model_id != current)
       |
       v
Immediately: Journal uses mixed-model querying
  - Query both stale and fresh vectors
  - Weight fresh vectors higher (1.5x relevance boost)
  - Quality degrades gracefully, never stops working
       |
       v
Background: Journal re-embeds stale vectors in small batches
  - Batch size: 50 entries per cycle
  - Pause between batches: 5 seconds (Pi) / 1 second (Mac Mini/VPS)
  - Rate-limited to avoid consuming all resources
  - Runs only during idle periods (no active user requests)
  - Progress surfaced in Bridge UI
       |
       v
Complete: All vectors use the new model, stale flag cleared
```

**Cost estimates for re-embedding (at 10,000 entries):**

| Method | Time | Memory | Cost |
|--------|------|--------|------|
| Local (all-MiniLM-L6-v2 on Pi 4) | ~30-60 minutes | 150-250 MB sustained | Free |
| Local (nomic-embed-text on 8GB Pi) | ~30-60 minutes | 500-800 MB sustained | Free |
| API (OpenAI text-embedding-3-small) | ~1-2 minutes | Negligible | ~$0.01 |

**User notification:** When the user changes embedding models, Bridge displays the estimated
re-embedding time and resource cost and asks for confirmation. The user can defer the
migration or cancel it at any point.
```

---

## Patch 11: Improve Backup Performance on Constrained Storage

**Severity**: P3 - Concern
**Review Finding**: #11 (Backup Performance on SD Cards)
**Target Section**: 8.4 (Backup and Recovery)

### Rationale

Daily full backups of all databases write 111-505 MB to disk. On an SD card, this takes 3-25 seconds of sustained writes, during which other I/O slows down and write endurance is consumed. The `PRAGMA integrity_check` after each backup doubles the I/O. The backup rotation (7 daily + 4 weekly + 3 monthly = 14 copies) could consume 7 GB on a 32 GB SD card.

### Changes

**8.4 -- Add performance notes after the existing backup description:**

```markdown
**Backup performance tuning:**

- **Use `PRAGMA quick_check` instead of `PRAGMA integrity_check`** for routine backup
  verification. `quick_check` verifies structural integrity without reading every row of
  every table -- it is approximately 100x faster. Reserve full `integrity_check` for
  manual diagnostic runs.

- **Compress backups**: SQLite databases compress well (typically 2-5x with zstd). Compress
  backup files immediately after creation to reduce storage consumption and SD card wear.

- **Reduced rotation for constrained storage**: On devices with < 64 GB storage, reduce the
  default rotation to 3 daily + 2 weekly + 1 monthly. The setup wizard detects available
  storage and adjusts the default.

- **Backup to external storage**: If an external drive (USB, network share) is available,
  prefer it as the backup destination. This avoids wearing out the primary storage device.

- **Scheduling**: Backups run during idle periods (default: 3:00 AM local time). During
  backup, Axis continues serving requests but deprioritizes non-urgent background tasks to
  reduce I/O contention.
```

---

## Patch 12: Optimize Token Counting on ARM64

**Severity**: P3 - Concern
**Review Finding**: #8 (tiktoken on ARM64)
**Target Section**: 11.1 (LLM API Optimization)

### Rationale

`tiktoken` tokenization on ARM64 (Pi 4) is 3-5x slower than on x86 (0.3-0.5ms per call vs. 0.1ms). With ~28 tokenization calls per Scout invocation for context window management, this adds ~8-14ms per request. Not a blocker, but avoidable with caching and approximation.

### Changes

**11.1 -- Add under the Token Management section:**

```markdown
**Token counting optimization:**

Exact token counting via `tiktoken` is used sparingly to minimize overhead, especially on
ARM64 where each call takes 0.3-0.5ms (vs. 0.1ms on x86):

- **Cache token counts for static content**: System prompts, Gear manifests, and other
  content that does not change between requests is counted once and cached.
- **Use character-based approximation for budget checking**: During context assembly,
  use `Math.ceil(text.length / 4)` as a fast approximation. This avoids ~27 `tiktoken`
  calls per request. Only invoke `tiktoken` for the final count before the API call.
- **ARM64 binary verification**: The chosen `tiktoken` package must have a native ARM64
  binary available. Native bindings are ~3x faster than the WASM fallback on ARM64. If
  native bindings are unavailable, use `js-tiktoken` (pure JS) as a fallback.
```

---

## Patch 13: Add Swap Configuration Guidance for Pi

**Severity**: P3 - Concern
**Review Finding**: #12.6 (Missing: Swap Configuration Guidance)
**Target Section**: 10.2 (Installation)

### Rationale

The default Raspberry Pi OS swap is 200 MB (via dphys-swapfile). This is too small for Meridian's workload. If memory pressure hits, the kernel will OOM-kill the process rather than swap. Proper swap configuration acts as a safety net.

### Changes

**10.2 -- Add after the installation options, under a "Raspberry Pi Setup" heading:**

```markdown
**Raspberry Pi system configuration:**

After installing Meridian, apply these system-level settings for reliable operation:

- **Swap**: Increase the swap file to 2 GB on the SSD (not the SD card -- swap I/O will
  destroy an SD card). Edit `/etc/dphys-swapfile`:
  ```
  CONF_SWAPSIZE=2048
  CONF_SWAPFILE=/mnt/ssd/swapfile   # Use the SSD mount point
  ```
  Set `vm.swappiness=10` in `/etc/sysctl.conf` to avoid swapping under normal conditions
  while allowing it as a safety net before OOM.

- **Memory overcommit**: Set `vm.overcommit_memory=0` (default) to prevent the kernel from
  promising more memory than is available. This causes `malloc` to fail early rather than
  triggering OOM kills later.
```

---

## Summary

| # | Patch | Severity | Section(s) Modified |
|---|-------|----------|---------------------|
| 1 | Move SQLite operations to a dedicated worker thread | P1 - Critical | 14.1, 5.1.1 |
| 2 | Publish a tested memory budget for Raspberry Pi | P1 - Critical | 11.2 |
| 3 | Recommend SSD over SD card for storage | P1 - Critical | 10.1, 10.2, 11.2 |
| 4 | Clarify Gear sandboxing mechanism and cap concurrent isolates | P1 - Critical | 5.6.3, 14.1 |
| 5 | Add missing performance infrastructure (GC tuning, watchdog, profiling, deadlines) | P1 - Critical | 11 (new 11.3), 5.1.5 |
| 6 | Address sqlite-vec brute-force search scaling | P2 - Serious | 5.4.5 |
| 7 | Add phase-aware scheduling to worker pool | P2 - Serious | 5.1.3 |
| 8 | Address memory leak vectors | P2 - Serious | 5.1.5, 5.6.4 |
| 9 | Improve cold start and first-request performance | P2 - Serious | 11.2, 5.5.1 |
| 10 | Add embedding model migration strategy | P2 - Serious | 5.4, 8.3 |
| 11 | Improve backup performance on constrained storage | P3 - Concern | 8.4 |
| 12 | Optimize token counting on ARM64 | P3 - Concern | 11.1 |
| 13 | Add swap configuration guidance for Pi | P3 - Concern | 10.2 |

### Cross-References with Other Patches

Several patches from this review interact with patches from other critic reviews:

| This Patch | Other Patch | Interaction |
|-----------|-------------|-------------|
| #1 (SQLite worker thread) | Database Engineer #12 (connection management) | **Complementary.** The database engineer's patch specifies heavy operations to offload; this patch makes ALL SQLite operations async via worker thread. The database engineer's read/write connection separation should be implemented within the worker thread. |
| #1 (SQLite worker thread) | Database Engineer #8 (PRAGMA config) | **Compatible.** PRAGMAs are set on connections within the worker thread. The `configureConnection()` function runs in the worker thread context. |
| #2 (Memory budget) | Database Engineer #4 (merge journal-vectors.db) | **Synergistic.** Merging journal-vectors.db into journal.db eliminates one database's page cache overhead (~8 MB default), helping the memory budget on Pi. |
| #3 (SSD recommendation) | Database Engineer #10 (WAL on SD cards) | **Complementary.** Both patches address SD card limitations. This patch recommends SSD as primary; the database engineer's patch provides WAL tuning for when SD cards are used. |
| #4 (Sandboxing clarification) | No direct overlap | N/A |
| #5 (Performance infrastructure) | Database Engineer #12 (event loop blocking) | **Supersedes partially.** The event loop monitoring in 11.3.3 subsumes the database engineer's concern about event loop blocking, while adding broader monitoring. |
| #10 (Embedding migration) | Database Engineer #4 (merge vector DB) | **Compatible.** The `embedding_metadata` table works whether vectors are in a separate database or merged into `journal.db`. If merged per database engineer's patch, the metadata table is created in `journal.db` alongside the vectors. |
| #11 (Backup performance) | Database Engineer #13 (backup consistency) | **Compatible.** The backup performance tuning applies to the quiet-period backup approach from the database engineer's patch. `quick_check` is used after the `VACUUM INTO` backup. |
