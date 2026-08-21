# Release Stage Serialization Design

## Context

`stage-v2` validates free bytes and inodes before extraction, but parallel signed stage requests can independently pass those checks and then consume aggregate capacity. Temporary upload, manifest, signature, and extraction paths are allocated before any shared release lock. Activation already serializes through `.release/deploy.lock` in the trusted launcher.

## Chosen design

`stage_release` will non-blockingly acquire the existing `.release/deploy.lock` before checking the target stage name, allocating temporary files, reading the archive, validating capacity, extracting, or moving the final directory. The lock remains held until the stage succeeds or its cleanup trap completes. Contention fails immediately with a stable release-gate error so concurrent workflows do not hang while streaming archives.

The same lock is reused for staging and activation. This intentionally serializes all disk-intensive staging with the active deployment and keeps the capacity check valid for the operation that follows it.

## Alternatives considered

1. Use a separate staging lock. Rejected because staging could still overlap activation and invalidate capacity assumptions.
2. Use a blocking lock. Rejected because an SSH workflow could wait indefinitely while retaining an archive stream and runner resources.
3. Reserve estimated bytes with a counter. Rejected because crash recovery and inode accounting would be more complex than serializing the low-frequency release path.

## Failure behavior

Lock contention is fail-closed and occurs before consuming stdin or creating stage-specific temporary paths. Existing signature, freshness, archive, capacity, and cleanup errors remain unchanged. Activation keeps its authoritative schema-floor check under the same lock.

## Testing

- Add a deterministic RED shell regression that holds `.release/deploy.lock`, invokes a signed `stage-v2`, and proves immediate rejection before archive consumption or temporary allocation.
- Prove a later stage succeeds after the lock is released.
- Run Bash syntax checks, `test/release-force-command.spec.sh`, `test/release-launcher.spec.sh`, and `git diff --check`.

## Success criteria

- At most one stage or activation operation can consume release filesystem capacity at a time.
- A contending stage fails promptly and leaves no upload, manifest, signature, extraction, or final stage artifact.
- Existing signed-protocol and activation behavior remains compatible.
