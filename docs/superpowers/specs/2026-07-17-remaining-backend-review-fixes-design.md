# Remaining Backend Review Fixes Design

## Scope

This change fixes four review findings that remain on `main`:

1. bound `GET /circle/my` with stable cursor pagination;
2. isolate `GET /auth/im-token` throttling by authenticated user;
3. make Prometheus metrics-token rotation safely repeatable;
4. replace note-share-link offset pagination with stable cursor pagination.

Anonymous access to `notes/*` and `chat/*` objects is explicitly excluded by
the user. This change must not alter the MinIO public-prefix policy or media URL
contracts.

## Constraints

- Preserve the existing bare-array response bodies for circle and share-link
  list endpoints.
- Use bounded defaults: `limit=50`, maximum `100`.
- Use deterministic `(createdAt DESC, id DESC)` ordering for every cursor list.
- A cursor is the UUID of the last item returned by the previous page.
- Reject cursors outside the authenticated user's current filter scope instead
  of accepting them as arbitrary timestamps.
- Keep the IM-token limit at 10 requests per 60 seconds; change only its key.
- Do not add product-level circle or share-link count limits.
- Do not change unrelated pagination endpoints.

## 1. My Circles Pagination

`MyCirclesQueryDto` gains optional `cursor` and `limit` fields. The controller
continues returning `MyCircleDto[]`, so existing response parsing remains
valid. Clients request another page when the response length equals the chosen
limit and pass the final returned circle ID as the next cursor.

For `tab=created`, the cursor must identify a non-deleted circle owned by the
current user. The query orders and seeks on the `Circle.createdAt` and
`Circle.id` pair.

For `tab=joined` and `tab=applied`, the cursor is still the returned circle ID,
but the service resolves it to the current user's matching `CircleMember` row.
The anchor must have the same membership status, satisfy the tab's role filter,
and belong to a non-deleted circle. Pagination orders and seeks on
`CircleMember.createdAt` and `CircleMember.id`.

An absent cursor starts at the newest row. An invalid or out-of-scope cursor
returns HTTP 400 with a stable `CIRCLE_INVALID_CURSOR` error code. This avoids
cross-user cursor probing and prevents a stale cursor from silently producing a
misleading page.

## 2. Authenticated IM-Token Throttling

Add a route-specific `ImTokenThrottlerGuard` derived from Nest's
`ThrottlerGuard`. Its tracker key is `user:<JWT userId>` after `JwtGuard` has
authenticated the request. It falls back to the framework's IP tracker only
when no authenticated user is present, preserving defensive behavior if the
guard is reused incorrectly.

`AuthController.imToken` uses guards in this order:

1. `JwtGuard` populates `req.user`;
2. `ImTokenThrottlerGuard` consumes the authenticated user tracker.

Two users behind the same source IP therefore receive independent 10/minute
budgets, while the eleventh request from one user still returns 429 without
calling OpenIM.

## 3. Repeatable Metrics-Token Rotation

`monitoring/sync-metrics-token.sh` must never attempt to truncate the existing
Prometheus-owned `0600` target as the deployment user. It writes the validated
token to a same-directory temporary file owned by the caller, then uses a
privileged install path to create a `0600`, uid/gid 65534 staged target and
renames that staged file over the destination.

The root path performs `install` and `mv` directly. The non-root path uses
`sudo` for both operations. If privileged installation is unavailable, the
script exits before changing the existing token and prints the exact command
the operator must run. A trap removes caller-owned temporary files on success
or failure.

Because replacing a host file changes its inode, the documented activation
command must recreate—not merely restart—the Prometheus container so Docker
binds the new file:

```bash
docker compose -f monitoring/docker-compose.yml \
  -f monitoring/docker-compose.prod.yml up -d --force-recreate prometheus
```

A Linux shell regression test runs the script twice with an existing target
that is not writable by the invoking deployment user, verifies both rotations
succeed through the privileged install shim, and confirms the second token is
the final file content with mode `0600` and uid/gid 65534. CI runs this test.

## 4. Note Share-Link Cursor Pagination

`ListNoteShareLinksQueryDto` replaces `page` with optional `cursor`, retains
`limit`, and lowers its maximum from 200 to the shared maximum of 100. There is
no production client for this newly introduced endpoint, so retaining an
offset compatibility path would preserve the correctness bug without a user
benefit.

The cursor must identify a share-link row owned by the authenticated user. The
query orders by `(createdAt DESC, id DESC)` and selects rows strictly after the
anchor. An invalid or foreign cursor returns HTTP 400 with stable
`NOTE_SHARE_LINK_INVALID_CURSOR`; it does not reuse the public
`NOTE_SHARE_LINK_INVALID` code because cursor errors are authenticated request
validation failures, not opaque link-resolution failures.

The response remains `NoteShareLinkDto[]`. A client obtains the next cursor
from the final returned link ID when a full page is returned.

## Error Handling

- Cursor validation happens before the page query.
- Empty result sets remain successful empty arrays.
- Deleted circles or memberships that leave the requested tab invalidate their
  cursor rather than shifting the anchor to another scope.
- Metrics-token rotation never replaces a working credential until token
  parsing and privileged staging have succeeded.
- IM-token throttling continues returning Nest's standard 429 response.

## Testing Strategy

Each behavior follows a red-green TDD cycle:

- circle service and DTO tests cover defaults, maximums, deterministic seek
  predicates, all three tabs, and foreign/stale cursors;
- auth HTTP tests prove two JWT users sharing one IP have independent budgets
  and one user's overflow never reaches `AuthService.getImToken`;
- the shell test proves first and repeated metrics-token rotation and failure
  before replacement when privilege is unavailable;
- note service, DTO, controller, and routing tests cover cursor validation,
  deterministic ordering, and removal of offset `skip`;
- targeted suites run after each fix, followed by full Jest, TypeScript/build,
  lint, shell syntax/behavior, and `git diff --check` verification.

## Deployment and Compatibility

- `GET /circle/my` keeps its array shape but becomes bounded. Clients that need
  more than one page must follow the documented last-ID cursor convention.
- `GET /note/share-links` is intentionally changed from page offsets to cursor
  pagination before a production client adopts it.
- IM-token response and rate values do not change.
- Operators must recreate Prometheus after token rotation as documented above.
- No database migration is required.
