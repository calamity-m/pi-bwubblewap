# Standalone Pi shutdown smoke test

Run this on Linux as a **non-root user** with standalone Pi (Bun 1.4.4)
loading this checkout of pi-bwubblewap. A separate Node installation must be
available on `PATH`, as required by the extension. Ensure another installed copy
of pi-bwubblewap is not also loaded.

The Node resource tests exercise permissions, removal, missing paths, and repeated
cleanup, but Node's recursive removal accepts mode-000 directories without the
teardown fix. This standalone-runtime check is required to catch that regression.

From the repository root, use a dedicated temporary parent so leftovers are easy
to identify:

```sh
smoke_tmp=$(mktemp -d /tmp/bwubblewap-smoke-XXXXXX)
TMPDIR="$smoke_tmp" pi -e ./extensions/index.ts -p 'say hi'
find "$smoke_tmp" -maxdepth 1 -name 'pi-bwubblewap-*' -print
```

Expected: the request completes, no shutdown extension error is reported, and
`find` prints **no session directories**. Do not treat a successful model response
alone as success. Repeat with an interactive session (omit `-p 'say hi'`) and exit
normally to check the same shutdown hook.

While the interactive session is active, check from another terminal:

```sh
find /tmp/bwubblewap-smoke-XXXXXX -path '*/runtime/masks/empty-dir' \
  -exec stat -c '%a %n' {} \;
```

Replace the parent path with the actual value of `smoke_tmp`. Each mask directory
must report mode `0` until teardown. After exiting Pi, repeat the session-directory
check: none should remain.

Remove the smoke-test parent when done:

```sh
rmdir "$smoke_tmp"
```

If Pi created unrelated temporary files in the parent, inspect and remove those
separately. On an unfixed build, restore owner access on any leftover
`pi-bwubblewap-*/runtime/masks/empty-dir` with `chmod 700` before removing that
session directory. Do not change mask permissions while a sandbox is active.
