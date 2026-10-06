# Note draft lifecycle limits

Draft writes, deletion and publication share the owner's database lock. Deletion retains a payload-free marker for **30 days**, so delayed autosaves cannot recreate the draft during that window. Repeating DELETE does not renew retention. After 30 days, discarded-only markers are removed on the owner's next PUT, DELETE or publication replay check. Clients returning to a discarded editor should generate a new draft ID rather than retrying an old ID indefinitely.

Each owner can retain 100 active drafts and 1,000 discarded-only markers. At the discard limit, creating a new active draft or deleting a never-created ID returns 409 until discarded markers expire. Updates and deletion of existing active drafts remain available, as does publication. Existing active drafts may add up to 100 further discarded markers, so the active-plus-discarded bound is 1,100. Recent markers are never evicted to admit new IDs.

Markers with `publishedNoteID` are durable publication results. They never expire, do not consume the discard quota, and remain available for safe replay even after the published note has been deleted. Deletion of a successful editor draft preserves its publication result.

A draft's combined, deduplicated inventory is limited to **150 object keys**, including media and posters from `mediaKeys`, all media sections, top-level blocks and section text blocks. Requests exceeding the limit return 400 before persistence or signing.

Publication retry must reuse both the same `clientDraftID` and the same payload. A consumed ID recovers the original publication result; it does not accept subsequent edits. Clients must preserve the unresolved submission across navigation/restart and confirm its result before opening a new editing lifecycle. A successful replay is not an acknowledgement of a changed retry payload.
