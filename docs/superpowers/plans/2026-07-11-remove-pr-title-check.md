# Remove PR Title Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop enforcing Conventional Commit formatting on pull request titles.

**Architecture:** Remove the standalone GitHub Actions workflow that runs `amannn/action-semantic-pull-request`. Leave every other workflow unchanged.

**Tech Stack:** GitHub Actions YAML, Git

## Global Constraints

- Remove only `.github/workflows/pr-title.yml`.
- Do not add a replacement title rule.
- Preserve all other workflows.

---

### Task 1: Remove the PR title workflow

**Files:**
- Delete: `.github/workflows/pr-title.yml`

**Interfaces:**
- Consumes: GitHub's workflow discovery under `.github/workflows`.
- Produces: A workflow set with no PR-title policy check.

- [ ] **Step 1: Delete the standalone workflow**

Delete `.github/workflows/pr-title.yml` with `apply_patch`.

- [ ] **Step 2: Verify no title-check references remain**

Run:

```powershell
rg -n "semantic-pull-request|Conventional PR title" .github/workflows
```

Expected: no matches.

- [ ] **Step 3: Verify all unrelated workflows remain**

Run:

```powershell
rg --files .github/workflows
```

Expected: `ci.yml`, `security.yml`, `semgrep.yml`, `claude-review.yml`, and `pr-notify.yml` are listed; `pr-title.yml` is absent.

- [ ] **Step 4: Commit**

```powershell
git add .github/workflows/pr-title.yml
git commit -m "ci: remove PR title check"
```
