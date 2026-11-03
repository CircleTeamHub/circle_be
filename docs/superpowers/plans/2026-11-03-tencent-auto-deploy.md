# Tencent automatic deployment implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy CI-verified main updates automatically to the existing Tencent Singapore backend at 43.134.85.95.

**Architecture:** Reuse the current signed, restricted-SSH release protocol and immutable GHCR images. Approve an exact digest of the reviewed database contract on both GitHub and the server; code-only updates may pass the historical irreversible marker, while database-contract changes fail closed until explicitly reviewed. Preserve the running database, COS configuration, Caddy routes, admin frontend, and temporary-chat frontend.

**Tech Stack:** GitHub Actions, Bash, Docker Compose, PostgreSQL, OpenSSH, RSA release signatures.

## Global constraints

- Target: 43.134.85.95, ubuntu, /home/ubuntu/circle_be, linux/amd64.
- Keep AUTO_RELEASE=off until the deployment channel and final end-to-end release are verified.
- Never print private keys, production env contents, or tokens; private release signing keys must never reach the server.
- Keep backups and the existing administrator SSH key. Add only a dedicated restricted deployment key.
- Do not unconditionally remove the historical irreversible migration marker or set irreversible flags for automatic releases.
- A newly added, removed, or changed migration, Prisma schema, schema compatibility level, or irreversible marker must invalidate the approved baseline.
- Both CI and the server must enforce the approved baseline; CI-only approval is insufficient.
- Preserve known-good tests and existing manual dangerous-migration confirmation behavior.
- Create a ready-for-review PR for repository changes. No draft PR.

### Task 1: Exact database-contract approval gate

**Files:** See `.superpowers/sdd/task-1-brief.md` for the complete task requirements.

- [ ] Write and run failing behavioral tests for baseline digest determinism, database-contract changes, and historical-marker approval.
- [ ] Implement the shared digest/approval helper and integrate it into Auto Release, Release validation, server deployment, and trusted tooling overlay.
- [ ] Run focused release contract suites and shell syntax checks; document how to approve a verified baseline.
- [ ] Commit the implementation and obtain an independent production-readiness review.

### Task 2: Configure the deployment channel

- [ ] Read-only audit the server's root-owned gate/launcher, SSH host key, database migration history, runtime files, and current image.
- [ ] Generate dedicated SSH and RSA signing keys locally, without logging private material.
- [ ] Prepare server setup with backups, immutable installed release tooling, exact baseline file, and restricted authorized-key entry; request any action-time confirmation required for granting new access.
- [ ] Set GitHub deployment secrets and non-secret host, user, path, platform, smoke URL, and baseline variables; keep automatic deployment disabled during setup.
- [ ] Verify unrestricted shell rejection, release capability negotiation, signing-key pairing, and the current production configuration.

### Task 3: End-to-end validation and activation

- [ ] Merge the reviewed, passing PR using the normal repository flow.
- [ ] Build and scan the amd64 image through GitHub Actions, then trigger a normal automatic release of main.
- [ ] Verify successful migration, active image revision equal to main, public health/auth checks, preserved frontends, and rollback metadata.
- [ ] Enable automatic release only after channel checks pass; verify a real main-triggered release and shut down all temporary processes.
