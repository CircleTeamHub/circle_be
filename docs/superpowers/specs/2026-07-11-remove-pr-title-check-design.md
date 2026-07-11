# Remove PR Title Check

## Decision

Delete `.github/workflows/pr-title.yml`. The team does not treat Conventional
Commit formatting as a merge requirement, so PR titles should not block CI.

## Scope

- Remove only the standalone `PR Title` workflow.
- Keep the main CI, Security, Semgrep, Claude Review, and PR Notify workflows.
- Do not replace the check with another title rule.

## Verification

- Confirm no workflow references `amannn/action-semantic-pull-request` or the
  `Conventional PR title` job.
- Confirm all remaining workflow YAML files are still present.
