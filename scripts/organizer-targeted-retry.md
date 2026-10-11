# Retry one Organizer review release

`Fix & retry` saves the title alias, then queues the selected unresolved review
entry. The organizer is not restarted. A manual file review can use `Retry this
release` after fixing the source files. Duplicate-library reviews retain their
comparison guidance.

The server accepts only a review ID, resolves its exact source basename from the
current review queue, verifies that the regular source still exists, and writes
a private durable request under `data/organizer-retries`. The packet includes
the source device/inode identity so a replaced same-name source cannot inherit
an earlier request. No request supplies an arbitrary path. Concurrent requests
for the same release coalesce; at most 64 pending releases are accepted.

The Python watcher claims requests only before scanning or between individual
imports. It bypasses a previous skip for the selected actual source name and
clears only its matching negative title cache. This preserves isolation when a
folder and a loose video share the same parsed stem. Aliases are read fresh by
the existing metadata lookup. Existing readiness, title-match, duplicate,
episode, runtime, copy verification and no-overwrite guards are unchanged.
Dry-run/manual-preview processes do not consume requests.

Queued/claimed status means the request is waiting for a safe attempt. Only an
`attempted` receipt indicates that the existing import workflow actually ran;
it does not claim the import succeeded. Review logs and filesystem state remain
the source of import success/failure. Requests for missing, changed, unsafe or
expired sources receive `rejected` receipts. Receipts are private and bounded to
the newest 128; pending requests are never pruned as history. A lifetime lock
allows one watcher to consume the spool, and interrupted claims are recovered
on the next normal watcher launch.

## Integration

Server factory:

```js
const retry = require('./lib/organizer-retry')({
  sourceDir: ORGANIZER_SOURCE_DIR,
  spoolDir: path.join(DATA_DIR, 'organizer-retries'),
  getReviewQueue: () => organizerTools.parseOrganizerFixQueue(
    readOrganizerLogLines(), getOrganizerAliases()),
});
```

The administrator-only POST `/api/organizer/retry` accepts `{id}` and awaits
`retry.enqueue(id)`. Add `retries: await retry.snapshot()` to the existing admin
fix-queue response. The frontend calls `api.organizerRetry(id)` and polls until
its request receives an attempted/rejected receipt, even if Live is off. Errors
have a sanitized message and HTTP `status` (400/404/409/503).

Install `scripts/organizer_retry_spool.py` beside the ignored live
`movie_renamer.py`, then dry-run and apply the focused patch against the current
ignored file. The patch was generated from production commit `8472dfd`'s ignored
organizer, preserving its earlier safety/matching changes:

```sh
cd media-organizer
patch --dry-run --forward -p0 < ../scripts/organizer-targeted-retry.patch
patch --forward -p0 < ../scripts/organizer-targeted-retry.patch
```

Load the updated code at the next planned organizer start. Routine retries then
need no restart. The watcher defaults to the same repo `data/organizer-retries`
as the server; an explicit `ORGANIZER_RETRY_DIR` must match the server spool path.
The default mode is owner-only: directory `0700` and request, claim, receipt and
lock files `0600`. Use it only when both processes run as the same user.

For separate server/organizer users, enable a dedicated private group explicitly.
Both processes must receive `ORGANIZER_RETRY_SHARED=1` and the same numeric
`ORGANIZER_RETRY_GID` (a nonzero dedicated group ID). The deployment administrator
must pre-create the spool as `root:<dedicated-group>` with mode `2770`, and give
both service identities that supplementary group. Shared mode refuses to create
the directory or broaden its permissions. It verifies the expected group,
current process membership, owner (root or the current service user), exact
`2770` directory mode and absence of symlinks. The root-owned directory allows
both service users to pass the owner check.

All shared request, claim, receipt and lock files use `0660` with the expected
group; setgid on the directory ensures group inheritance. Creation corrects a
restrictive process umask on each owned open file before publication. Readers
reject records with a different group or mode. The directory is never chmodded
by either service. No world access is introduced. Example deployment values:

```ini
SupplementaryGroups=tvclone-retry
Environment=ORGANIZER_RETRY_SHARED=1
Environment=ORGANIZER_RETRY_GID=<numeric-tvclone-retry-gid>
```

These settings belong in both service drop-ins. Provision the dedicated group
with only the server and organizer service users. Check execute/traverse access
on every ancestor of the spool separately: group access to the spool cannot
override a private parent `data` directory. If an ancestor blocks one service,
give that service a narrow traverse ACL or use an explicit shared spool outside
that private parent; do not open the private data directory to everyone. The
Node `spoolDir` and Python `ORGANIZER_RETRY_DIR` must point to the same location.
Verify enqueue, claim and receipt with the actual service identities before
enabling routine retries. No media files need to be moved for this check.

## Focused fixture checks

```sh
node lib/organizer-retry.test.js
python3 -m unittest discover -s scripts -p test_organizer_retry_spool.py -v
ORGANIZER_RETRY_TEST_SOURCE=/absolute/path/to/staged/movie_renamer.py \
  python3 -m unittest discover -s scripts -p test_organizer_retry_spool.py -v
```

The final command also exercises the actual patched import functions, extracted
without importing private configuration or running the CLI. All queries and
media moves in those checks are mocked; files are temporary fixtures only.
