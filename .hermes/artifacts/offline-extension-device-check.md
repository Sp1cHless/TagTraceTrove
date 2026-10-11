# Optional grouped device check — Gallery / Preview extension only

Status: DEVICE UNVERIFIED. Matching v41 APK has been built and verified (`0.0.41-c3-gallery-preview-offline`, versionCode 41); it has not been installed or tested on the phone in this session. This sequence covers only the new extension, not the user-closed historical App register.

## Prerequisite / deployment boundary

Use a compatible desktop server advertising the new capabilities and schema 037, plus the matching client. This session has not migrated the formal DB, restarted the default server, installed an APK or changed signing keys. Formal deployment remains separately authorised; do not run migrations or restart services merely to execute this checklist. Capability downgrade must fail closed and retain work.

Take a disposable Entry with a cover and several easily distinguished previews, plus an unrelated Entry. Avoid important original content. Use ordinary visual identity (different pictures), not only URL text, to judge ordering.

## 1. Gallery order and cold reopen

Download/Update the offline copy while online. Disconnect. In Exchange, move visible neighbours with a NSFW-hidden Gallery in between. The visible order should change while hidden membership remains intact. Cold reopen and confirm the order survives. Reconnect; desktop and phone should converge. With a deliberate peer reorder, pending work should become a clear conflict rather than silently winning.

## 2. Preview additions, deletions and local persistence

Disconnect with all original media cached. Add two different previews to the disposable existing Entry, then close/reopen it and cold reopen the app. Newly staged pictures and unchanged cover/original previews should remain visible. Perform consecutive deletes and mixed delete→append / append→delete actions. Observe actual remaining picture identities and order, not just counts.

## 3. Cancel a staged addition

For a genuinely fresh native-issued addition that has not been claimed/attempted, add an image and another after it, then remove the first before reconnection. Cold reopen. The cancelled image must remain absent and the intended surviving staged image must remain visible; released chain survivors are explicitly foreground-only and must not resurrect through stale native captures. If native attempt history is unknown, legacy or already attempted, removal must instead be disabled with an actionable reason and preserve the exact original pending work. Merely disconnecting does not prove never-attempted. Negative pending-created Entry IDs must be clearly gated, never reported as a successful no-op.

## 4. Reconnect and conflict boundary

Reconnect the unchanged queue. Compare final desktop/phone cover and preview picture order. Reopen after successful reconciliation and ensure removed pictures do not resurrect. On a separate disposable attempt, let the desktop change/reorder the same media before reconnecting the phone: the peer mismatch should retain visible conflicted work; the unrelated Entry should still progress. Actual response/ACK-loss retry is covered by automated isolated transport tests, not claimed from casual airplane-mode toggling.

## 5. Native/foreground reporting

With queued preview work, inspect pending status and foreground/background reporting. If preview operations are foreground-only, the UI must say so rather than claiming they were scheduled. Independent eligible work should not be falsely blocked by an unrelated held preview. OS force-stop, WorkManager timing and WebView/native behavior require separate observed matching-build evidence; JVM/IDB passes are not device acceptance.

Record only actually observed results against the final build marker. This one compound sequence is optional and does not gate each internal patch or imply that old accepted UI/IME/caching tests need repeating.
