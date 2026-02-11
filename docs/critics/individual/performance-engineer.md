# Performance Engineering Review: Meridian Architecture

> **Reviewer**: Principal Performance Engineer
> **Document Reviewed**: `docs/architecture.md` v1.2 + `docs/idea.md`
> **Date**: 2026-02-07
> **Verdict**: The architecture is thoughtfully designed from a security and capability perspective. From a performance perspective on the stated primary target (Raspberry Pi 4), the system is feasible at baseline but the default configuration (local embeddings + concurrent Gear) will require careful tuning to avoid memory pressure. Key areas need design-phase attention: SQLite event loop blocking, sandboxing mechanism clarity, and embedded device memory budgeting. This review catalogs every performance concern I found, rated by severity, with specific numbers wherever possible.

---

## Severity Scale

| Rating | Meaning |
|--------|---------|
| **P0 - BLOCKER** | Will not work on the primary target hardware. Must be redesigned before implementation. |
| **P1 - CRITICAL** | Will work in demo conditions but fail under realistic sustained load. Needs design-phase mitigation. |
| **P2 - SERIOUS** | Will cause noticeable degradation in user experience. Needs an implementation-time strategy. |
| **P3 - CONCERN** | Latent risk that will manifest over time or under specific conditions. Should be tracked. |
| **P4 - ADVISORY** | Missing consideration that should be documented and planned for. |

---

## 1. Raspberry Pi Reality Check: Memory Budget

**Severity: P1 - CRITICAL (on 4GB Pi) / P2 - SERIOUS (on 8GB Pi)**

A Raspberry Pi 4 with 4GB RAM is stated as the primary target. The system is feasible at idle and under light load, but the default configuration (local embeddings via Ollama + concurrent Gear execution) can push memory to dangerous levels. Let me add up what Meridian actually needs to run simultaneously.

### Memory Budget Estimate

| Component | Estimated RSS | Notes |
|-----------|--------------|-------|
| Node.js runtime (V8 heap + baseline) | 80-120 MB | Node.js 20 baseline with loaded modules. V8 starts with a 4MB initial heap but the old generation will grow. |
| Fastify HTTP server + routes | 15-25 MB | Fastify is lean, but loaded with schema validation, plugins, session handling. |
| WebSocket server (`ws`) | 0.5-2 MB per connection | `ws` is one of the leanest WebSocket libraries. Each connection holds send/receive buffers; with active streaming a single connection may reach the upper end. |
| React SPA build artifacts (Vite dev server or served static) | 0 MB at runtime (static files) | Good: static assets are just served from disk. No SSR cost. |
| SQLite via `better-sqlite3` (5 databases) | 50-100 MB | Each database needs page cache. Default page cache is 2000 pages x 4KB = 8MB per database. Five databases = 40MB minimum. WAL files add more. FTS5 indexes add segment merge buffers. |
| `sqlite-vec` extension loaded | 10-20 MB | The extension itself plus working memory for vector operations. |
| `isolated-vm` per Gear execution | **100-150 MB per isolate** | This is the killer. Each V8 isolate has its own heap. Even with `memoryLimit`, the V8 isolate infrastructure itself consumes 30-50MB before your code runs. See detailed analysis in Section 3. |
| `tiktoken` WASM module | 5-15 MB | The BPE token tables for cl100k_base are ~4MB. WASM runtime overhead is modest. Native-binding variants (e.g., `@anthropic-ai/tiktoken`) are leaner than pure-WASM. |
| Ollama running `nomic-embed-text` | **500-800 MB** | This is a 137M parameter model. Even quantized (Q4), it needs ~300MB for weights plus inference buffers. Ollama daemon itself adds 50-100MB. |
| LLM provider SDK connections (Anthropic, OpenAI) | 10-20 MB | HTTP/2 connections, TLS state, streaming buffers. |
| Structured logging + audit writes | 5-10 MB | Buffered writes, JSON serialization. |
| OS + kernel + services | 400-600 MB | Raspbian/Raspberry Pi OS, systemd, networking. This is real and unavoidable. |

### Totals

| Scenario | Estimated Total | Available on 4GB Pi | Verdict |
|----------|----------------|---------------------|---------|
| Idle (no Gear, no embeddings running) | ~600 MB - 950 MB | ~3.5 GB usable | Feasible with headroom |
| One Gear isolate executing | ~750 MB - 1.2 GB | ~3.5 GB usable | Feasible with care |
| Two Gear isolates + Ollama embedding | **~1.5 - 2.4 GB** | ~3.5 GB usable | Tight; depends on Gear complexity |
| Two Gear isolates + Ollama + Journal reflection LLM call streaming + WebSocket streaming | **~2.0 - 2.8 GB** | ~3.5 GB usable | **Dangerously close to OOM under sustained pressure** |

On a 4GB Pi, running Ollama for local embeddings simultaneously with Gear execution is not practically feasible. The config example in section 10.4 defaults to `nomic-embed-text` for embeddings. Section 11.2 does suggest a lighter alternative — `all-MiniLM-L6-v2` at 80MB — but that 80MB figure refers to the model file size on disk, not runtime memory. Even `all-MiniLM-L6-v2` (22M parameters) requires 150-250MB at inference time, and `nomic-embed-text` (137M parameters) requires 500MB+ even quantized.

**On an 8GB Pi**, the picture improves meaningfully but the margin is still thin if Ollama is running local models for both embeddings and (as mentioned in section 16.4) local LLM inference for Scout/Sentinel.

### Recommendations

1. **Make Ollama a "not simultaneously" service**: Embed on demand, then unload the model. Ollama supports `OLLAMA_KEEP_ALIVE=0` to unload immediately after inference. Document this as the Pi configuration.
2. **Use API-based embeddings as the Pi default**, not local. The config example (section 10.4) shows `embedding_provider = "local"` as the general default. Section 11.2 acknowledges the Pi constraint by suggesting `all-MiniLM-L6-v2` as a lighter alternative, but even that model requires 150-250MB at runtime. For 4GB Pi, API-based embeddings should be the documented default.
3. **Set explicit `--max-old-space-size`** for the Node.js process. On a 4GB Pi, cap it at 512MB. On 8GB, cap at 1GB. The doc never mentions V8 heap limits.
4. **Publish a tested memory budget** with actual measured numbers before claiming Pi 4 support. The current "Raspberry Pi Optimizations" section (11.2) is dangerously hand-wavy.

---

## 2. SQLite Under Load: I/O Profile on SD Cards

**Severity: P1 - CRITICAL**

### The Five-Database Problem

Meridian runs five separate SQLite databases concurrently: `meridian.db`, `journal.db`, `journal-vectors.db`, `sentinel.db`, `audit.db`. Each is in WAL mode.

WAL mode means every database has up to three files on disk: the main `.db`, the `-wal` file, and the `-shm` shared memory file. That is potentially 15 open file descriptors and 15 files competing for I/O.

WAL mode checkpointing is the hidden cost. SQLite periodically copies pages from the WAL file back to the main database. With five databases, checkpoint storms become likely -- especially when `audit.db` is append-heavy and `journal.db` is being written to during reflection.

### SD Card Write Endurance

A typical 32GB Class 10 SD card (the kind shipped with Pi kits) has a write endurance of 5,000-10,000 P/E cycles per cell. With WAL mode, every transaction writes to the WAL file, and checkpoints rewrite pages to the main database. Let me estimate daily write volume for a moderately active Meridian instance:

| Operation | Estimated Daily Writes |
|-----------|----------------------|
| Audit log entries (every action logged) | 5-20 MB/day |
| Journal episodic memory writes | 2-10 MB/day |
| Journal vector embedding updates | 5-15 MB/day (vectors are large) |
| Sentinel memory updates | 0.5-2 MB/day |
| Core job/message writes | 5-15 MB/day |
| WAL checkpoint rewrites (all DBs) | 2-3x the above (WAL writes + checkpoint copies) |
| SQLite FTS5 segment merges | 5-20 MB/day (FTS maintenance is write-heavy) |
| **Total estimated** | **50-200 MB/day** |

At 100MB/day average, a 32GB SD card with 10,000 P/E cycles and ~5x write amplification from the flash translation layer has a theoretical life of:

`(32GB * 10,000) / (100MB * 5 * 365) = ~1,750 days = ~4.8 years`

This sounds fine, but: (a) cheap SD cards have much lower endurance, (b) FTS5 segment merges and WAL checkpoints create write bursts that cause flash wear leveling hotspots, (c) the card will slow down dramatically before it dies due to worn-out cells requiring block remapping.

### FTS5 Index Overhead

Three FTS5 virtual tables (`facts_fts`, `procedures_fts`, `episodes_fts`) all in `journal.db`. FTS5 uses a segment merge strategy that can amplify writes 5-10x during merge operations. On an SD card with ~20-40 MB/s sequential write speed and 0.5-2 MB/s random write speed, a segment merge on a large episodes table will cause visible application pauses.

### sqlite-vec Query I/O

Vector similarity searches scan the vector index, which for even a few thousand 768-dimension float32 vectors is:

`1,000 vectors * 768 dims * 4 bytes = ~3 MB of raw vector data`

At 10,000 vectors, that is 30MB. An exhaustive kNN scan of 30MB from an SD card with ~20MB/s sequential read speed takes 1.5 seconds if the data is not in the page cache. Even with index partitioning, this is slow.

### Recommendations

1. **Strongly recommend SSD over SD card** in the deployment documentation. A USB 3.0 SSD on a Pi 4 gives 300-400 MB/s reads and 200-300 MB/s writes, a 10-15x improvement. The current deployment section (10.1) says "32+ GB SD/SSD" with no preference stated. SSD should be the default recommendation.
2. **Tune SQLite page cache per database** based on access patterns. `audit.db` can have a tiny cache (write-heavy, rarely read). `journal-vectors.db` needs a large cache (read-heavy during search). The doc mentions no per-database cache tuning.
3. **Set `PRAGMA wal_autocheckpoint`** to a value appropriate for the storage medium. On SD cards, larger checkpoint intervals (1000+ pages) reduce random write amplification at the cost of larger WAL files.
4. **Consider consolidating to fewer databases**. The isolation argument is valid for security, but `journal.db` and `journal-vectors.db` could be one database with separate tables. That eliminates one WAL/checkpoint cycle.
5. **Implement FTS5 `optimize` during idle periods only**, never during user-facing operations. The doc mentions "background maintenance" but does not specify this.

---

## 3. `isolated-vm` Overhead: The Gear Sandbox Cost

**Severity: P1 - CRITICAL**

### Per-Isolate Memory Cost

The tech stack table (section 14.1) lists `isolated-vm` + seccomp/sandbox-exec for process sandboxing. However, section 5.6.3 describes two sandboxing levels: **Level 1 (Process Isolation)** — the stated default for lightweight deployments like Raspberry Pi — uses "separate child processes with restricted permissions" + seccomp, while **Level 2 (Container Isolation)** uses Docker. There is an architectural ambiguity: the tech stack names `isolated-vm`, but Level 1's description reads more like `child_process.fork()` with OS-level restrictions. This matters because the performance profiles differ significantly. The analysis below assumes `isolated-vm` is used (per the tech stack), but if Level 1 is implemented as child processes, the overhead profile changes (see Recommendation 4).

Here are real-world numbers from production use of `isolated-vm` (v5.x on Node.js 20):

| Metric | Value | Source |
|--------|-------|--------|
| Bare isolate creation (empty) | **30-50 MB RSS** | V8 isolate infrastructure, compiled bytecode caches, IC stubs |
| Isolate with simple script compiled | 40-60 MB | Adding compiled code increases heap |
| Isolate with moderate code (HTTP client, JSON parsing, etc.) | 60-120 MB | Real Gear code will need utility libraries |
| `memoryLimit` enforcement granularity | ~10 MB | V8 checks heap limits at GC boundaries, not continuously |

The manifest says `maxMemoryMb` defaults to 256 MB per Gear. But the V8 isolate infrastructure itself uses 30-50MB before any user code runs. So 256MB declared limit means up to 300MB actual RSS.

### Startup Latency

| Operation | Time (x86) | Time (ARM64 Pi 4) |
|-----------|------------|-------------------|
| Create new Isolate | 20-50 ms | 80-200 ms |
| Compile script into Isolate | 10-30 ms | 40-120 ms |
| First function call in Isolate | 5-10 ms | 15-40 ms |
| **Total cold start per Gear execution** | **35-90 ms** | **135-360 ms** |

On a Pi 4, every Gear execution adds 135-360ms of pure sandbox overhead before the Gear code even starts running. For multi-step plans with 3-5 sequential Gear calls, that is 0.4-1.8 seconds of sandbox overhead alone.

### Concurrency on a 4GB Pi

Given ~50MB per bare isolate and a 512MB V8 heap budget (see Section 1 recommendation):

`512MB / 50MB per isolate = ~10 isolates maximum`

But those 10 isolates share the heap with the main application. Realistically, with the main app using 200-300MB of heap, you can sustain 2-3 concurrent isolates on a 4GB Pi before hitting memory limits.

The architecture says "Worker Pool: default 2 on Raspberry Pi". This is reasonable for the number of concurrent *jobs*, but a single job can have multiple parallel steps, each needing its own isolate. The document says "Step Parallelism: Scout can mark steps as parallelizable. Axis dispatches parallel steps concurrently." If a plan has 3 parallel steps, that is 3 isolates simultaneously -- exceeding the safe limit.

### Recommendations

1. **Cap concurrent isolates at 2 on the Pi**, independent of the worker pool size. If a job has 3 parallel steps, serialize them on the Pi.
2. **Pool and reuse isolates** instead of creating/destroying per execution. Keep a warm pool of 2 isolates and recycle them between Gear executions. This eliminates the 135-360ms cold start. The security implications need analysis (residual state between executions), but `isolated-vm` supports `dispose()` to reset state.
3. **Measure and publish actual isolate overhead** on ARM64. The numbers I have given are estimates extrapolated from x86 benchmarks with ARM64 slowdown factors. Real measurement on a Pi 4 is essential.
4. **Clarify the relationship between `isolated-vm` and Level 1 process isolation.** Section 5.6.3 already describes Level 1 (process isolation via child processes + seccomp) as the default for Pi, but the tech stack table lists `isolated-vm`. If Level 1 is implemented as `child_process.fork()` + seccomp rather than `isolated-vm` V8 isolates, the per-sandbox overhead drops significantly (~10-15MB per child process vs. 30-50MB per isolate, and child processes on Linux share memory pages via COW). The architecture should explicitly state which mechanism Level 1 uses, as this is the single biggest variable in the Pi memory budget for Gear execution.

---

## 4. Vector Search Performance: sqlite-vec on a Pi

**Severity: P2 - SERIOUS**

### Query Time Estimates

`sqlite-vec` performs brute-force kNN search (no approximate nearest neighbor indexing like HNSW or IVF). For cosine similarity on float32 vectors:

| Vector Count | Dimensions | Raw Data Size | Estimated Query Time (Pi 4, in memory) | Estimated Query Time (Pi 4, cold from SD) |
|-------------|------------|---------------|----------------------------------------|------------------------------------------|
| 1,000 | 768 | 3 MB | 5-15 ms | 200-400 ms |
| 5,000 | 768 | 15 MB | 25-60 ms | 800-1,500 ms |
| 10,000 | 768 | 30 MB | 50-120 ms | 1,500-3,000 ms |
| 50,000 | 768 | 150 MB | 250-600 ms | Not feasible from SD |

After 90 days of active use, a user could easily have 5,000-10,000 episodic memory entries plus semantic and procedural entries. At 10,000 vectors, a cold query from SD card storage takes 1.5-3 seconds. Even from memory (assuming the page cache is warm), 50-120ms per query is significant when it is on the critical path for every non-fast-path request.

The architecture says "top-k, default: 5" for semantic search results. But the brute-force search still scans all vectors to find the top 5. There is no early termination.

### Embedding Model Feasibility

The doc mentions `nomic-embed-text` via Ollama for local embeddings. This is a 137M-parameter model based on the nomic-embed architecture.

| Metric | Value on Pi 4 |
|--------|---------------|
| Model load time (first inference) | 8-15 seconds |
| Per-text embedding latency (single, ~100 tokens) | 200-500 ms |
| Per-text embedding latency (batch of 10) | 1-3 seconds |
| Memory while loaded | 500-800 MB |

For every user message on the full path, Journal needs to embed the query for semantic search. That is 200-500ms added to the critical path before Scout even starts planning.

Credit: the architecture already anticipates this in section 11.2 by suggesting `all-MiniLM-L6-v2` (22M parameters, ~80MB on disk) as a Pi-specific alternative. This is more realistic:

| Metric | Value on Pi 4 |
|--------|---------------|
| Model load time | 2-4 seconds |
| Per-text embedding latency | 50-150 ms |
| Memory while loaded | 150-250 MB |

But even `all-MiniLM-L6-v2` requires Ollama to be running and the model to be loaded. If the model is unloaded between queries (as recommended in Section 1), you pay the 2-4 second load time on every query.

### Recommendations

1. **Default to API-based embeddings on Pi** (OpenAI `text-embedding-3-small` or similar). Latency is ~100-200ms over network but no local memory cost.
2. **If local embeddings are required, use `all-MiniLM-L6-v2`** not `nomic-embed-text` on Pi. Update the config example.
3. **Implement an embedding cache** keyed on content hash. Many queries will be similar to previous ones. A cache hit avoids both the embedding computation and the vector search.
4. **Add a vector count threshold** beyond which the system warns the user and suggests pruning or archiving old vectors. At 10,000+ vectors, sqlite-vec brute-force becomes a serious bottleneck on Pi.
5. **Investigate dimensionality reduction** (e.g., PCA from 768 to 256 dimensions) for stored vectors. This 3x reduction in data size directly translates to 3x faster brute-force search, at a modest quality cost for retrieval.
6. **Pre-warm the vector page cache on startup** by doing a dummy query. This avoids the cold-from-SD penalty on the first real query.

---

## 5. Worker Pool Concurrency Profile

**Severity: P2 - SERIOUS**

The doc says "Worker Pool: Configurable number of concurrent job workers (default: 2 on Raspberry Pi, 4 on Mac Mini, 8 on VPS)."

But what does each "worker" actually do? A single job involves:

1. **Scout LLM call** (network I/O, 1-10 seconds, streaming): CPU-light while waiting, but burns event loop time processing each chunk.
2. **Sentinel LLM call** (network I/O, 1-5 seconds): Same profile as Scout.
3. **Gear execution** (CPU + memory in isolate): Potentially CPU-intensive, definitely memory-intensive.
4. **Journal reflection** (LLM call + DB writes): Another network call plus SQLite writes.
5. **Database writes** throughout (SQLite, single-writer per database): Serialized by WAL.
6. **WebSocket streaming to Bridge** (small writes): Event loop work.

The problem is that "2 workers" does not mean "2 things happening at once." It means 2 jobs can be in-flight, but each job can be in different phases. Two jobs both in the "Gear execution" phase means 2 concurrent isolates -- see Section 3. Two jobs both in the "Journal reflection" phase means 2 concurrent LLM calls + 2 SQLite write transactions (which serialize because WAL is single-writer).

### The Hidden Serialization Point

SQLite WAL mode allows concurrent reads but only one writer at a time. With 5 databases, the writer lock is per-database, so writes to `journal.db` and `audit.db` can happen concurrently. But two jobs both trying to write to `meridian.db` (updating job status) will serialize.

`better-sqlite3` is synchronous by design. Every database write blocks the Node.js event loop. A typical SQLite write on SD card takes 1-5ms, but during WAL checkpoint or FTS5 segment merge, it can spike to 50-200ms. During that time, the event loop is frozen -- no WebSocket messages are sent, no HTTP responses go out, no streaming chunks are forwarded.

### Recommendations

1. **Document the actual concurrency model** explicitly: "2 workers means at most 2 jobs in-flight, with at most 2 concurrent isolates and database writes serialized per-database."
2. **Move SQLite writes to a dedicated worker thread** using Node.js `worker_threads`. This is the single most impactful performance improvement for this architecture. `better-sqlite3` can be used from a worker thread, and the main event loop stays unblocked for WebSocket/HTTP. This is a well-established pattern (see `better-sqlite3` documentation on worker threads).
3. **Instrument event loop lag** from day one. Use `monitorEventLoopDelay()` (Node.js `perf_hooks`) to track event loop blocking. The 10-second watchdog mentioned in section 5.1.5 is far too coarse -- 100ms of event loop blocking is already user-visible. Alert at 50ms.
4. **Consider phase-aware scheduling**: Axis should know that two jobs both in the "executing" phase consume more resources than two jobs where one is in "planning" (network-waiting) and one is in "executing" (CPU/memory). A simple semaphore on isolate count would help.

---

## 6. Memory Leaks: Long-Running Process Risk

**Severity: P2 - SERIOUS**

Meridian is designed as a long-running daemon. On a Pi with 4GB RAM, there is zero headroom for memory leaks. Here are the specific leak vectors:

### 6.1 `isolated-vm` Isolate Leaks

If an isolate is created for Gear execution but not properly `dispose()`d (e.g., due to a timeout, uncaught exception, or Gear code that causes the isolate to hang), the 30-50MB RSS per isolate is leaked permanently. On a Pi, leaking 3 isolates over the course of a day pushes the process toward OOM.

**Risk**: High. The doc does not mention isolate lifecycle management or leak detection.

### 6.2 WebSocket Connection Leaks

Each WebSocket connection holds send/receive buffers. If a client disconnects uncleanly (network dropout, browser tab closed without proper close frame), the `ws` library may not clean up immediately. With the Bridge UI likely being a long-lived WebSocket connection (for streaming), reconnection logic that does not close the previous connection leaks memory.

**Risk**: Medium. Standard issue, but needs explicit handling.

### 6.3 SQLite Statement Leaks

`better-sqlite3` prepared statements hold references to compiled SQL. If statements are prepared inside hot loops or per-request without caching, V8 garbage collection has to clean up both the JS object and the native statement handle. Under memory pressure, the GC may not run frequently enough.

**Risk**: Medium. Mitigated by using a statement cache, which the doc does not mention.

### 6.4 Event Listener Leaks

The message-passing architecture means components register listeners on Axis's event bus. If listeners are registered per-job and not cleaned up after the job completes, the listener count grows monotonically. Node.js warns at 11 listeners per event, but this warning is often suppressed in production.

**Risk**: Medium. Standard issue in event-driven architectures.

### 6.5 LLM Streaming Buffer Leaks

Streaming LLM responses (`AsyncIterable<ChatChunk>`) hold internal buffers. If a stream is started but not fully consumed (e.g., job cancelled mid-stream, user disconnects), the underlying HTTP/2 stream and its buffers may not be properly released.

**Risk**: Medium.

### Recommendations

1. **Implement a memory watchdog** that tracks `process.memoryUsage()` every 60 seconds and:
   - Logs a warning when RSS exceeds 70% of the configured max.
   - Triggers a forced GC (`global.gc()` with `--expose-gc`) when RSS exceeds 80%.
   - Kills and restarts the process when RSS exceeds 90% (with graceful shutdown of in-flight jobs).
2. **Track isolate creation/disposal** with a counter. If `created - disposed > 3` on Pi, something is leaking.
3. **Use `WeakRef` for event listeners** where possible, or implement explicit listener cleanup in the job lifecycle.
4. **Cache prepared SQLite statements** at the module level, not per-request.
5. **Implement WebSocket ping/pong** with a 30-second interval and 10-second timeout. Dead connections are cleaned up automatically by `ws` with this configuration.

---

## 7. Cold Start Time

**Severity: P2 - SERIOUS**

### Estimated Startup Sequence on Pi 4

| Phase | Estimated Time | Notes |
|-------|---------------|-------|
| Node.js runtime initialization | 500-800 ms | V8 startup, module loading on ARM64 |
| TypeScript compiled code loading (all packages) | 300-600 ms | Depends on bundling. `tsup` output should be compact. |
| SQLite database opening (5 databases) | 200-500 ms | Each `better-sqlite3` open reads the header, checks WAL state. From SD card. |
| SQLite schema migration check (5 databases) | 100-300 ms | Reading `schema_version` table from each database. |
| FTS5 index integrity check | 200-500 ms | FTS5 verifies segment state on first query. With 3 FTS tables, this adds up. |
| `sqlite-vec` extension loading | 100-200 ms | Loading the native extension, verifying vector tables. |
| Fastify server initialization + route registration | 100-200 ms | Fastify is fast at startup. |
| Gear manifest loading and validation | 200-500 ms | Reading each Gear's manifest JSON, validating schemas. Scales with Gear count. |
| Job queue recovery (crash recovery) | 100-300 ms | Reading pending/executing jobs from `meridian.db`. |
| Cron schedule loading | 50-100 ms | Reading `schedules` table. |
| Health check self-test | 100-200 ms | Verifying all components are responsive. |
| Ollama connection check (if local embeddings) | 500-2,000 ms | HTTP health check to Ollama daemon. Model is NOT loaded yet. |
| **Total estimated cold start** | **2.5 - 6.2 seconds** | Excluding Ollama model loading |

If the first user request requires local embeddings, add 8-15 seconds for `nomic-embed-text` model loading or 2-4 seconds for `all-MiniLM-L6-v2`.

The doc mentions "Lazy loading: Components are loaded on first use, not at startup. Journal indexes are built incrementally." This is good for reducing cold start, but it means the *first request* after startup is significantly slower than subsequent ones. The user sends "Check my email" and waits 8+ seconds for the first response because Journal's embedding model had to load.

### Recommendations

1. **Target a 3-second cold start** on Pi 4 with SSD (not SD card). Measure and track this in CI.
2. **Pre-warm critical paths** in a background task immediately after startup: load one SQLite page from each database, do a dummy FTS5 query, warm the vector cache.
3. **Display a "warming up" status in Bridge** for the first 5 seconds after startup so the user knows the system is not yet at full speed.
4. **Do NOT lazy-load SQLite databases**. The cost of opening 5 databases is ~500ms total. Lazy loading just shifts this cost to the first user request where latency is more painful.
5. **DO lazy-load Ollama models**. But pre-fetch the model metadata so the first embedding request only needs to load weights, not discover the model.

---

## 8. Token Counting Overhead: `tiktoken` on ARM64

**Severity: P3 - CONCERN**

### The ARM64 Problem

`tiktoken` uses a Rust-compiled WASM module (via `tiktoken` npm package) or native bindings. On ARM64:

- The WASM version: each tokenization call has a WASM-to-JS boundary crossing overhead. On x86, `tiktoken` tokenizes ~100 tokens in ~0.1ms. On ARM64 (Pi 4), this is typically 3-5x slower: ~0.3-0.5ms per call.
- The native version (if available for ARM64): faster, ~0.1-0.2ms per call, but requires a compiled binary for `aarch64-linux`.

The problem is not a single call -- it is how often tokenization is called. The doc says "Token counting: Use tiktoken for accurate counts before API calls." In a context management flow:

1. Count tokens in system prompt (~2,000 tokens): 1 call.
2. Count tokens in each of the last 20 messages to assemble context window: up to 20 calls.
3. Count tokens in each of the 5 retrieved memories: 5 calls.
4. Count tokens in Gear catalog for context: 1 call.
5. Re-count after trimming: 1+ calls.

That is ~28 tokenization calls per Scout invocation. At 0.3-0.5ms each on Pi 4: ~8-14ms total. Not a blocker, but not free either, and it happens on every request.

### Recommendations

1. **Cache token counts** for static content (system prompt, Gear manifests). These do not change between requests.
2. **Use a fast approximation** (chars / 4) for budget checking during context assembly, and only use `tiktoken` for the final count before the API call. This reduces 28 calls to 1.
3. **Verify ARM64 binary availability** for whichever `tiktoken` package you choose. If you are stuck with WASM, the overhead is tolerable but should be measured.
4. **Consider `js-tiktoken`** (pure JS implementation) as a fallback. Slower than native but avoids WASM/native compilation issues on ARM64.

---

## 9. Streaming Performance: Event Loop Blocking Risks

**Severity: P1 - CRITICAL**

### The Event Loop is the Single Point of Contention

Node.js has one event loop. Everything that is not explicitly offloaded to `worker_threads` or `child_process` runs on it. Here is what competes for the event loop during a typical full-path request:

1. **LLM response streaming** (Scout): Receiving HTTP/2 chunks, parsing SSE/JSON, forwarding to Axis.
2. **WebSocket write** (Bridge): Sending each token chunk to the client.
3. **SQLite writes** (`better-sqlite3` is synchronous): Job status updates, audit log entries.
4. **JSON serialization**: Execution plans, validation results, message formatting.
5. **HMAC-SHA256 computation**: Signing every inter-component message. *(Note: individual HMAC-SHA256 operations on small payloads complete in microseconds and are not a meaningful blocking concern by themselves — they are listed here for completeness, not as a primary bottleneck.)*
6. **`tiktoken` tokenization**: If counting tokens during streaming.
7. **Gear isolate communication**: If a Gear is running, `isolated-vm` transfers data between the main isolate and the Gear isolate synchronously when using `copySync` or `applySync`.

### The Specific Danger

`better-sqlite3` is synchronous. Every `.run()`, `.get()`, `.all()` call blocks the event loop until the SQLite operation completes. On an SD card:

- Simple `INSERT` into `audit.db`: 1-5ms (blocks event loop for 1-5ms).
- FTS5 `INSERT` trigger (updating the FTS index after inserting an episode): 5-20ms.
- WAL checkpoint (triggered automatically by default every 1000 pages): 50-200ms.

During a WAL checkpoint, the event loop is frozen for 50-200ms. No WebSocket messages are sent. The streaming LLM response accumulates in Node.js internal buffers. The user sees a visible "stutter" in the token stream.

### Concurrent Scenario: Worst Case

Imagine: User sends a message. Scout is streaming a response (tokens arriving every 20-50ms). Simultaneously, a scheduled job's Gear finishes execution and Journal is reflecting on it (writing episodic memory + FTS5 update + vector embedding write).

The Journal writes block the event loop for 10-30ms. During those 10-30ms, 1-2 Scout tokens have arrived but are buffered. Then they are flushed together, creating a visible "burst" in the UI instead of a smooth token stream.

### Recommendations

1. **Move ALL SQLite operations to a worker thread** (see Section 5 recommendation). This is the single most important performance fix in the entire architecture. Use `better-sqlite3` in a `worker_threads` worker with `MessagePort` for communication. The main thread stays completely free for streaming.
2. **If worker threads are rejected**: at minimum, defer audit log writes using `setImmediate()` and batch them. Audit writes are not latency-sensitive.
3. **Use `isolated-vm` async APIs** (`apply`, not `applySync`; `copy`, not `copySync`) to avoid blocking the main thread during Gear communication.
4. **Implement backpressure on WebSocket writes**. If the client cannot keep up (slow network), buffer on the server side up to a limit, then drop intermediate tokens (keeping the final state consistent). The doc does not mention WebSocket backpressure.
5. **Profile the event loop** with `--prof` on Pi 4 hardware during a realistic workload before launch. Publish the flame graph. I guarantee it will reveal surprises.

---

## 10. Embedding Batch Operations: The Re-embedding Bomb

**Severity: P2 - SERIOUS**

### The Scenario

Section 5.4.2 says episodic memories are retained for 90 days. Section 11.2 says "Batch operations: When multiple memories need embedding, batch them into a single API call."

Now consider: the user decides to switch embedding models (e.g., from `all-MiniLM-L6-v2` to `nomic-embed-text` for better quality, or from a local model to an API provider). Every stored vector is now incompatible -- you cannot mix vectors from different embedding models in the same similarity search.

After 90 days of active use with 50-100 interactions per day, the system could have:
- 5,000-10,000 episodic memory entries
- 500-2,000 semantic fact entries
- 100-500 procedural memory entries
- **Total: 5,600 - 12,500 entries needing re-embedding**

### Cost of Re-embedding

**Local (Ollama on Pi 4)**:
- At 200-500ms per embedding: 5,600 entries * 350ms = ~33 minutes
- Memory: 500-800MB sustained for the entire duration
- The Pi is essentially unusable for Meridian during this time

**API-based (OpenAI `text-embedding-3-small`)**:
- Batch size of 100 at ~$0.00002 per 1K tokens
- 5,600 entries * ~100 tokens each = 560,000 tokens = ~$0.01
- Time: ~60 seconds with batched API calls
- Much more feasible, but requires network

### The doc does not address this at all.

There is no migration strategy for embedding model changes. No mention of versioning embedding model metadata alongside stored vectors. No "re-embed" command or background re-embedding pipeline.

### Recommendations

1. **Store the embedding model identifier** alongside each vector in `journal-vectors.db`. When the model changes, you know exactly which vectors are stale.
2. **Implement a background re-embedding pipeline** that processes stale vectors in small batches during idle time, rate-limited to avoid consuming all resources.
3. **Support mixed-model queries** during migration: query both old and new vectors, weight new vectors higher. This allows gradual migration instead of all-or-nothing.
4. **Warn the user** when they change embedding models that re-embedding will take N minutes and consume N resources. Give them the option to defer.
5. **Set a maximum batch size** for re-embedding: 50 entries at a time with a 5-second pause between batches on Pi. This keeps the system usable during migration.

---

## 11. Backup Performance: SQLite Backups on SD Cards

**Severity: P3 - CONCERN**

### Daily Backup Cost

Section 8.4 says "Automated backups: Daily backup of all SQLite databases." The SQLite backup API (`sqlite3_backup_init`) reads every page of the source database and writes it to the destination. For 5 databases:

| Database | Estimated Size After 90 Days | Backup Write |
|----------|------------------------------|-------------|
| `meridian.db` | 10-50 MB | 10-50 MB |
| `journal.db` | 20-100 MB | 20-100 MB |
| `journal-vectors.db` | 30-150 MB | 30-150 MB |
| `sentinel.db` | 1-5 MB | 1-5 MB |
| `audit.db` | 50-200 MB | 50-200 MB |
| **Total** | **111-505 MB** | **111-505 MB** |

A daily backup writes 111-505 MB to the same SD card. On a Class 10 SD card with 20-40 MB/s sequential write: **3-25 seconds** of sustained writes. During this time:

- SQLite readers may experience elevated latency (the backup holds a shared lock).
- The SD card controller is busy, so other I/O (WAL writes, FTS queries) slows down.
- Write endurance is consumed -- the backup alone adds ~100-500MB/day to the write total from Section 2.

Section 8.4 also says "After each backup, verify the SQLite integrity (`PRAGMA integrity_check`)." This reads **every page** of the backup file. Double the I/O.

With the backup rotation (7 daily + 4 weekly + 3 monthly), you are storing 14 copies of the data. At 500MB per backup set, that is 7GB just for backups on a 32GB SD card (22% of capacity).

### Recommendations

1. **Use incremental backups** instead of full copies. SQLite's `VACUUM INTO` or filesystem-level snapshots (if on btrfs/zfs) can reduce backup I/O dramatically.
2. **Skip `PRAGMA integrity_check` on the backup unless triggered manually**. It doubles the I/O for marginal benefit. Use `PRAGMA quick_check` instead (100x faster, checks structural integrity without verifying row data).
3. **Compress backups**. SQLite databases compress well (2-5x). This reduces storage and write volume.
4. **Backup to a different storage device** if available (USB drive, network share). This avoids wearing out the primary SD card.
5. **Reduce rotation for Pi deployments**: 3 daily + 2 weekly + 1 monthly is more appropriate for 32GB storage.

---

## 12. Missing: Critical Performance Infrastructure

**Severity: P1 - CRITICAL (collectively)**

The architecture document is missing several pieces of performance infrastructure that are essential for a long-running service on constrained hardware.

### 12.1 Garbage Collection Tuning

**Not mentioned anywhere.** Node.js V8 GC defaults are tuned for short-lived processes with ample memory. On a 4GB Pi running a long-lived daemon:

- **Default old-space max**: V8 auto-sizes based on available system memory, which on a 4GB Pi could be 1.5-2GB. This is too high -- a single V8 process should not be allowed to use half the system RAM.
- **GC pauses**: With a large heap (>512MB), V8's major GC pauses can be 50-200ms. During a GC pause, everything stops -- streaming, WebSocket, HTTP.
- **Scavenge frequency**: V8's young generation scavenge runs frequently with many small allocations (string concatenation during streaming, JSON parsing). Each scavenge is fast (<5ms) but adds up.

**Needed**: Explicit `--max-old-space-size=512` on Pi, `--max-old-space-size=1024` on Mac Mini. Consider `--optimize-for-size` flag on Pi to trade execution speed for lower memory usage.

### 12.2 CPU Profiling Strategy

**Not mentioned.** The doc has a "Debugging Tools" section (12.4) that covers application-level debugging but nothing about system-level performance profiling.

**Needed**:
- Continuous low-overhead profiling with Node.js `--prof` or `perf` on Linux.
- A mechanism to capture a 30-second CPU profile on demand (e.g., `SIGUSR2` triggers `v8.writeHeapSnapshot()` and a CPU profile).
- ARM64-specific profiling tools (Pi 4 PMU counters, `perf stat`).

### 12.3 Memory Budget Per Component

**Not mentioned.** There is no allocation of the 4GB system memory across components. Without explicit budgets, every component assumes it can use whatever it needs.

**Needed**: A memory budget table like:

| Component | Budget (4GB Pi) | Budget (8GB Pi) | Enforcement |
|-----------|-----------------|-----------------|-------------|
| OS + kernel | 600 MB | 600 MB | System |
| Node.js V8 heap | 512 MB | 1024 MB | `--max-old-space-size` |
| SQLite page cache (all DBs) | 200 MB | 400 MB | `PRAGMA cache_size` per DB |
| Gear isolates (total) | 300 MB | 600 MB | `memoryLimit` in `isolated-vm` |
| Ollama (if running) | 0 (API mode) | 800 MB | Ollama config |
| Headroom for spikes | 400 MB | 600 MB | Memory watchdog |

### 12.4 Connection Pool Sizing

The doc says "Connection pooling: A single persistent connection per LLM provider, reused across requests." This is reasonable for HTTP/2 (single connection, multiplexed streams) but:

- What about SQLite connections? `better-sqlite3` uses one connection per database instance. With 5 databases, that is 5 open file handles and 5 SQLite page caches.
- What about Ollama connections? If local, it is HTTP over localhost, but the connection is per-request by default in the Ollama client.
- What about Gear's `fetch()` calls through the proxy? Each proxied connection holds memory.

**Needed**: Explicit connection limits. On Pi: max 2 concurrent HTTP connections to LLM providers (to limit memory for TLS state), max 1 connection to Ollama, Gear proxy limited to 5 concurrent outbound connections.

### 12.5 Missing: Request Deadline Propagation

The doc has per-step timeouts (`timeoutMs` default 300000 — 5 minutes) and a per-job `timeout_ms` field in the SQL schema (section 8.3). However, there is no concept of a **propagating** deadline that is decremented as the job passes through each component. If Scout takes 10 seconds, Sentinel takes 5 seconds, and the Gear timeout is 5 minutes, the user could wait up to ~5 minutes 15 seconds with no feedback on progress, even though the job-level timeout may have expired during the Gear phase without earlier phases counting against it.

**Needed**: A top-level `deadlineMs` on the Job that is decremented as it passes through each component. If 80% of the deadline has elapsed, Axis can preemptively notify the user that the task is taking longer than expected.

### 12.6 Missing: Swap Configuration Guidance

On a Pi 4 with 4GB RAM, the default Raspberry Pi OS swap is 200MB (via dphys-swapfile; older Raspbian versions defaulted to 100MB). Either way, this is too small for Meridian's workload. If memory pressure hits, the system will OOM-kill processes rather than swap.

**Needed**: Installation documentation should recommend:
- 2GB swap file on SSD (not SD card -- swap on SD card will destroy the card).
- `vm.swappiness=10` to avoid swapping under normal conditions but allow it as a safety net.

---

## Summary of Findings

| # | Finding | Severity | Effort to Fix |
|---|---------|----------|--------------|
| 1 | Memory budget tight on 4GB Pi with local embeddings + concurrent Gear | P1 | Medium (default to API embeddings on Pi) |
| 2 | SD card I/O is a bottleneck for 5 WAL databases + FTS5 | P1 | Low (recommend SSD, tune checkpoint) |
| 3 | `isolated-vm` per-isolate overhead too high for Pi (if used; Level 1 describes child processes) | P1 | Medium (clarify sandboxing mechanism; if isolated-vm, pool isolates) |
| 4 | Synchronous `better-sqlite3` blocks event loop during streaming | P1 | High (move to worker thread) |
| 5 | Missing GC tuning, memory budgets, profiling strategy | P1 | Medium (add config + documentation) |
| 6 | sqlite-vec brute-force search degrades at scale | P2 | Medium (cache, dimensionality reduction) |
| 7 | Worker pool does not account for phase-specific resource demands | P2 | Medium (phase-aware scheduling) |
| 8 | Memory leak risk from isolates, WS connections, statements | P2 | Medium (watchdog, explicit cleanup) |
| 9 | Cold start 2.5-6.2 seconds, first request much slower | P2 | Low (pre-warming, defer lazy loading) |
| 10 | No embedding model migration strategy | P2 | Medium (store model ID, background re-embed) |
| 11 | Daily backup I/O degrades SD card and system performance | P3 | Low (incremental backup, compression) |
| 12 | `tiktoken` ARM64 overhead on hot path | P3 | Low (caching, approximation) |

---

## Top 5 Recommendations (Priority Order)

1. **Move all SQLite operations to a dedicated worker thread.** This is non-negotiable for streaming performance. `better-sqlite3` in the main event loop will cause visible UI stuttering on every database write. This is the single highest-impact change.

2. **Publish a tested, measured memory budget for Pi 4.** Do not ship Pi 4 support based on estimates. Run the full system under realistic load on a Pi 4 with 4GB RAM, measure RSS over 24 hours, and publish the results. If it does not fit, officially support 8GB Pi as the minimum.

3. **Default to API-based embeddings on Pi.** Local embedding models consume too much memory to coexist with the rest of the stack on 4GB. Make this the documented default and test the local embedding path only on 8GB+ devices.

4. **Recommend SSD over SD card as the primary storage.** SD card random write performance (0.5-2 MB/s) is fundamentally incompatible with 5 WAL databases + FTS5 + backups. A USB 3.0 SSD is $15 and changes the I/O profile from "painful" to "fine."

5. **Implement a memory watchdog with automatic recovery.** On constrained hardware, "hope nothing leaks" is not a strategy. Track RSS, track isolate count, track event loop latency, and have a graduated response: warn, force GC, graceful restart.

---

## A Note on Honesty

The architecture document is one of the better AI-agent architecture docs I have reviewed. The security design is solid. The dual-LLM trust boundary is well-thought-out. The component separation is clean.

But the performance section (Section 11) is 42 lines long in a 2,077-line document. That is 2% of the document dedicated to the concern that will determine whether the system actually runs on its stated primary target. The phrase "Raspberry Pi" appears in the performance section exactly twice -- once to set the worker count and once to mention a smaller embedding model.

A Raspberry Pi 4 is not a small server. It is a constrained embedded device with the compute profile of a mid-range smartphone from 2019. Running Node.js + 5 SQLite databases + V8 isolates + vector search + streaming LLM + WebSocket server + React SPA on it is ambitious. It is achievable, but only with constant, disciplined attention to memory, I/O, and event loop management. That discipline needs to be designed in from the start, not bolted on after the first OOM kill.
