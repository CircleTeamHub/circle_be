# Chat Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose bounded Prometheus metrics for the self-hosted chat gateway, visualize the capacity signals in Grafana, and remove stale OpenIM scrape targets.

**Architecture:** Add a small isolated `ChatMetrics` registry-backed service with gauges, counters, and histograms. Inject it into the chat gateway so connection lifecycle, message handling, rate-limit/auth failures, and broadcast timing are recorded without user-derived labels. Merge the registry into the existing `/metrics` endpoint, then add dashboard panels and alerts for saturation and latency.

**Tech Stack:** NestJS, Socket.IO gateway, `prom-client`, Jest, Prometheus, Grafana JSON provisioning.

---

### Task 1: Define chat metric behavior with tests

**Files:**
- Create: `src/chat/chat-metrics.spec.ts`
- Create: `src/chat/chat-metrics.ts`

- [x] **Step 1: Write failing tests** for connection gauges, message counters, bounded labels, latency histograms, and reset-safe isolated registries.
- [x] **Step 2: Run the focused Jest test and verify it fails because the metrics module does not exist.
- [x] **Step 3: Implement the minimal registry-backed metrics service with bounded low-cardinality labels.
- [x] **Step 4: Run the focused test and verify it passes.

### Task 2: Instrument the self-hosted chat gateway

**Files:**
- Modify: `src/chat/chat.gateway.ts`
- Modify: `src/chat/chat.gateway.spec.ts`

- [x] **Step 1: Add tests for connection open/close and send success/failure/rate-limit observations.
- [x] **Step 2: Run the focused gateway tests and verify the new expectations fail.
- [x] **Step 3: Attach the metrics singleton and record lifecycle and message observations without adding user IDs or conversation IDs as labels.
- [x] **Step 4: Run the focused gateway tests and verify they pass.

### Task 3: Expose metrics through the existing backend endpoint

**Files:**
- Modify: `src/setup.ts`
- Modify: `src/metrics/metrics.integration.spec.ts`

- [x] **Step 1: Add an integration assertion that `/metrics` contains the chat metric family.
- [x] **Step 2: Run the focused metrics integration test.
- [x] **Step 3: Merge the chat registry into the existing registry passed to the metrics handler.
- [x] **Step 4: Run the focused metrics tests and verify they pass.

### Task 4: Update Prometheus, Grafana, and alerting configuration

**Files:**
- Modify: `monitoring/prometheus/prometheus.yml`
- Modify: `monitoring/prometheus/prometheus.prod.yml`
- Modify: `monitoring/prometheus/alerts.yml`
- Modify: `monitoring/grafana/dashboards/circle-be.json`
- Modify: `docs/metrics.md`
- Modify: `docs/observability.md`

- [x] **Step 1: Remove stale OpenIM scrape jobs now that chat is self-hosted.
- [x] **Step 2: Add Grafana panels for connections, message QPS, ACK p95, broadcast p95, rate limiting, and event-loop lag.
- [x] **Step 3: Add actionable alerts for chat latency, event-loop lag, and connection saturation.
- [x] **Step 4: Document the new PromQL queries and the distinction between per-instance connections and globally deduplicated users.

### Task 5: Verify the complete change

- [x] **Step 1: Run the focused chat and metrics tests.
- [x] **Step 2: Run typecheck and lint.
- [x] **Step 3: Validate Prometheus/Grafana JSON/YAML syntax with the repository's available tooling or targeted parsing checks.
- [x] **Step 4: Review the diff and confirm existing user modifications remain untouched.
