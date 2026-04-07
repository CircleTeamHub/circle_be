# Prisma Bootstrap Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add explicit, conservative database bootstrap controls without changing the default fail-fast production behavior.

**Architecture:** Keep `DATABASE_URL` required by default, add explicit env flags for boot-time connection skipping and optional degraded startup, and centralize the env semantics so `AppModule` and `PrismaService` agree. Track connection state in `PrismaService` and expose lazy reconnect behavior for controlled callers.

**Tech Stack:** NestJS, Prisma, Joi, Jest

---

### Task 1: Cover env validation semantics

**Files:**
- Create: `src/config/env.validation.ts`
- Test: `src/config/env.validation.spec.ts`
- Modify: `src/app.module.ts`

- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Run the test to verify it fails**
- [ ] **Step 3: Implement shared env validation helpers**
- [ ] **Step 4: Run the test to verify it passes**

### Task 2: Cover Prisma bootstrap controls

**Files:**
- Create: `src/prisma/prisma.service.spec.ts`
- Modify: `src/prisma/prisma.service.ts`

- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Run the test to verify it fails**
- [ ] **Step 3: Implement explicit boot-skip and degraded-start semantics**
- [ ] **Step 4: Run the test to verify it passes**

### Task 3: Verify targeted and broader checks

**Files:**
- Test: `src/config/env.validation.spec.ts`
- Test: `src/prisma/prisma.service.spec.ts`
- Test: relevant existing unit tests

- [ ] **Step 1: Run targeted Jest commands for new coverage**
- [ ] **Step 2: Run a broader Jest selection for regression confidence**
