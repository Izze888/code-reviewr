<!--
General bug patterns learned from real, confirmed bugs that AI reviewers
missed. Suds Review reads this file before every diff. Edit freely: add
your own lessons in the same format, or delete ones that do not fit.
-->

# Suds Review lessons (updated 2026-10-13)

## 1. Destructive or binding writes before the operation succeeds

Look for code that deletes, retires, declines, rebinds, consumes a single-use code, or repoints a record before the operation it serves has succeeded. If the later step fails, the working state is gone and nothing restores it. Check that retire or decline steps run only after the new state is confirmed, and that every failure path leaves the original untouched or restores it.

Example: A reconnect flow saves the new connection reference before the external link finishes. When linking fails, the old working connection is orphaned.

## 2. Follow-up records must ride on the caller's own conditional write

When a state change (promote, drop, claim) is followed by a derived record such as a conversion, card, or ledger row, check that the record is written in the same transaction. It should be written only when this caller's conditional update changed exactly one row. A logged and swallowed failure loses the record with no retry. Two racing callers that both write regardless of their own outcome duplicate it unless a unique key fences it.

Example: Promote and drop race on the same record. Both insert a conversion row because neither checks its own update count.

## 3. Every surface that shows or pays money must share one calculation

When logic changes how carryover, late items, held amounts, or prior coverage are netted, check every surface that shows or pays the amount: tables, payment forms, drafts, history views, and success notices. Each must call the same helper with the same inputs, including people with no row in that period. Carryover must be passed as its real value, not zero. Notices and history must report every amount actually written, not a partial sum.

Example: The summary table nets prior coverage, but the draft payout still adds the full carryover and pays late items twice.

## 4. Settlement coverage must handle nested, containing, and spanning periods

When a payment settles a range, check that every overlapping range sees that coverage: ranges inside it, ranges containing it, earlier periods whose carryover it paid, and later periods holding late items. Stamp a payment with the full range it settles, not only the range on screen. Query settled runs that overlap the view, not only ones that contain it or come after it. Split a run spanning several periods once. Never cap it per slice.

Example: A 30-day view ignores a paid weekly run inside it, so the payment form prefills an amount that was already paid.

## 5. Netting must subtract only what is truly settled, once, in order

When pay nets clawbacks, carryover, held cash, or pending commission, check that amounts already consumed or reserved are subtracted once. A negative balance from an old overpayment must not become a new deduction. Allocate payments in the same order the final payout uses. Cumulative totals, such as all pending amounts before a cutoff, must be scoped to the period. A paid status must win over held leftovers.

Example: A clawback already absorbed by a reservation is subtracted again, cutting pay twice.

## 6. Optimistic money checks must fingerprint every input to the stored amount

A money write may read amounts before a lock or retry wrapper, then re-check a fingerprint inside the transaction. In that case, list every input to the stored value and confirm each one is in the fingerprint or re-read inside. Otherwise a sibling record can change state in that window, including across database-busy retries. The write then saves a stale amount and later balances net wrongly.

Example: The owed amount is computed before the lock. A sibling run is marked paid during a retry, and the fingerprint does not cover it.

## 7. Merges must use the survivor and retarget every child record

When a helper merges, absorbs, or blocks a record, check that callers use the returned survivor for later writes: credits, status changes, offers, reservations, and conversation threads. Blocked records get no automations or money state, and every send queue rechecks blocked status. When children move to a survivor, collapse duplicates per workflow or thread, and stop children left on archived duplicates. Rollbacks must move a child back only if the survivor still holds that same child.

Example: After a merge, an offer is attached to the archived duplicate. Both copies' workflow enrollments move over, so messages send twice.

## 8. Consent and required disclosures must match purpose and come first

When stored consent lets a form skip its consent box, check that the consent's purpose matches the form. Consent given for bookings does not cover job applications. The server must check purpose before recording messaging consent. When a channel requires a first-message disclosure, such as an automated-assistant notice, check that every early branch (help, menu, keywords, handoffs) runs after the disclosure or includes it.

Example: A customer's first HELP text gets the help reply without the required automated-assistant notice.

## 9. Concurrency fences must use a state or generation token, not stored timestamp text

Claims, takeovers, and stale-lock rescues, especially on money paths, must not compare stored datetime text in SQL, such as status time <= cutoff. Mixed timestamp formats, for example in SQLite, can block the takeover and strand a crashed charge. Require a random token or generation column as the fence, and decide staleness in code.

Example: A stale-claim rescue compares a text timestamp to a cutoff. Mixed formats mean it never matches, leaving a customer charged with no fulfillment and no refund.

## 10. Side effects performed before taking the lock

When a flow takes a lock or claim row (order insert, lease, name reservation), check every write before it: connecting hosts, copying or deleting DNS records, charging. Work done before the lock can race another tenant. Also verify that the failure or cleanup path reverts that work in every failed outcome (refund, refusal, busy), not only when no row was written.

Example: A domain transfer copies DNS and connects hosting before reserving the name, and leaves hosting connected after the registrar refuses.

## 11. Money and message logic must cover every kind and variant

When settlement, refund, late-success, or reconcile code handles some order kinds, such as purchase and transfer, check that the others, such as renewal, get matching handling. That includes a null observed value that blocks a refund forever and late external successes that are never recorded. Check that send idempotency keys include every dimension that changes the message. Check that safety caps test every later price, and that items are offered only when the purchase can succeed.

Example: Reminder keys leave out whether the item renews or expires, so the second message type is deduplicated away.

## 12. Owed amounts must use the canonical refund-aware balance

Flag new code that recomputes what a customer owes as line totals minus successful payments, ignoring refunds and fees. Use the same balance the charge path uses. Check that unit-level credits, such as gift cards, are matched against that unit's item, not every item on a shared grouped invoice.

Example: A resend-payment-link check ignores a partial refund and treats the invoice as paid.

## 13. Revenue, credit, and payment evidence must filter by source and status

When code sums money or credits for a report, ad platform, or incentive, check that every row is filtered by source (website vs. agent channel) and by status. Status covers canceled or refunded credits, not only cancelled jobs. Check that purchase and refund values read the same line set without double-counting copies of invoice lines. Credit logic must handle every kind of holder row. Payment evidence, such as cash holds, must use the same status and method filters as the payout logic.

Example: Canceled credits are counted as website revenue and reported to the ad platform.

## 14. Gate on effective status, including terminal and derived states

Check gating code that reads a stored status when the real state is derived (past expiry, zero balance, canceling). A canceling subscription is not active. A paid or booked hold must never re-enter a create or claim path, so fence those writes on status and paid time. Soft-deleted siblings must not count as unfinished work. Dedupe must not treat failed or skipped rows as coverage. Give-up clocks start when the work was queued. Receipts say sent only when it sent.

Example: Resending a payment link on an already-paid hold overwrites its checkout session reference.

## 15. Records and controls must be reachable from every role and path

When a release, write-off, or settlement record is created only by one actor's action, check states that other roles or older paths reach, such as a void by a user without that permission. A no-op guard can leave no way to create the record. If downstream loaders key periods on an updated time or status time, the new write must bump that field. When a control moves behind a role gate, every role that used it must still reach it.

Example: The release record is created only when a manager voids. A void by a lower role leaves the held amount stuck forever.

## 16. Per-user scoping must cover every read, write, and side channel

When a diff limits a user to their own records, check every path: aggregate counts and scores, bulk writes such as reordering, mark-read on shared inboxes, calls as well as texts, and lookups by legacy or null keys (for example local phone format vs. E.164). A record that fails to match must not read as unowned. Confirm the gate checks the same value the action uses.

Example: A scoped user cannot text another user's contact but can still call them, because the call path checks a different id than the one it dials.

## 17. Privileged actions must check write authority and the live validity window

When a diff widens who can see a record (helpers, shared queues, grants), find every mutating action guarded only by the read-access check. Pause, resume, discard, and reassign need the write check. When ownership is time-bound (expiry, lease end), every privileged action must apply the same expiry test as the lock. A grant limited to certain dates must not add people to rosters or pickers outside those dates.

Example: A helper with view access can pause automation because the pause action checks only read access.

## 18. Automated moves and undo must recheck every guard the forward action uses

For take-back, batch moves, undo, and share refunds, list the guards the forward action enforces: booked, closed, or archived stage, an open held reservation, minimum time with the current owner, and a helper actively responding. Each sibling path must apply all of them. Fence the write on the owner and stage that were read, so a reassignment landing between read and write cannot credit or refund the wrong person.

Example: Undo moves a record back to the pool even though it was booked in the meantime.

## 19. Changing owner, source, or period must reset dependent state

When a record's owner, source (site URL, project id, canonical host), or period changes, check every stamp tied to the old one: first-contact times, approvals, crawl findings. Reconcile must not overwrite a fresher handoff stamp or ignore contact already made. Later steps must not run when reconcile stopped early. Pin a customer-facing agent name at first send. Close runs that are still open at period rollover.

Example: After reassignment, the new owner inherits the old owner's first-contact time and looks like they already replied.

## 20. Classify states from the tenant's saved config, not seed defaults or hardcoded keys

When code decides a record is open, booked, lost, or closed, check it reads the tenant's actual configuration. Falling back to seed defaults on missing or damaged settings makes custom stages look open. An unknown board id must not resolve through the current default board. Hardcoded stage keys miss custom stages. Destructive actions such as marking lost, merging, refunding, or reassigning should refuse on damaged or stale config rather than guess.

Example: Settings fail to parse, the code falls back to default stages, and a custom Booked column is treated as open and marked lost.

## 21. Calendar dates must convert to instants in the business time zone

When a form validates a date-only value (start date, due date, paid-through) as a calendar day in the business's time zone, check that the code turning it into a stored instant uses that same zone. Storing UTC midnight makes a Pacific-time tomorrow already past in the evening. The record is then immediately due, past due, or charged early by a renewal job. Check that every comparison of now against the stored instant matches the validator's day rule.

Example: A billing start of tomorrow is stored as UTC midnight. For a client added at 6pm Pacific it is already past, and the nightly job charges them.

## 22. Paired reads and fences must share the same bounds and keys

When two queries feed one number or decision (a count and its list, earnings and payments, a save fence and the key it guards), check that both use the same date floor, lookback, and filters. Day-scoped lookups must cover records spanning midnight, such as an overnight shift's work site. Filtering on an optional column drops rows that an older fallback join found, so keep the fallback.

Example: Payments load 40 days back but earnings only two days back, so the code writes a false deduction.

## 23. Retry and failure paths must finish the work and sync state

When a claim or done marker is written before the side effect, check that a failed side effect leaves the retry able to redo it rather than report success. Every failure branch must release the claim or store a lasting reason, so the next run does not loop on busy. On the client, a handled confirm must refresh the data or close the view. A consumed single-use code must check whether another confirm already finished.

Example: A done marker is written before the side effect. After a failure, the retry sees the marker and skips the work.

## 24. Stale background jobs and events overwriting newer state

For crawls, polls, webhooks, multi-step form saves, and async fills, check that the writer proves it still owns the record (current URL, attempt id, generation) at write time, not only at start. Order by attempt identity, not save timestamps. An older consent event must not undo a later opt-out. A redelivered close must not shut a thread that a newer inbound message reopened. When an owner clears a field that a fill writes only when blank, the filler must respect that.

Example: A redelivered conversation-closed webhook closes a thread that a newer customer message reopened, hiding the staff reply box.

## 25. Send timing markers must mean a real send for this step

When cadence or follow-up timing reads a last-sent field, check every writer. A discard that stamps it delays later steps. Per-phone history must not stand in for per-step state. Every send mode, including fully automatic, must check for a waiting draft first. When a setting skips a step, also skip steps written as its follow-up, since an empty last-sent time will not hold them back. Nudges that depend on shift or duty must check it in every branch.

Example: An opener is disabled, but its follow-up still sends because the empty last-sent time does not block it.

## 26. Webhook routing must be tenant-scoped and use fields live payloads carry

When a webhook handler claims events for one subsystem by heuristics, such as a recent pending send, check the match is scoped to the same tenant and message. Otherwise another tenant's events are held or answered with errors. Check that the match fields actually appear in live provider payloads, not only in test fakes. A missing field makes the claim never fire, and a 200 response stops redelivery.

Example: Delivery events match any recent pending send across all tenants, and the match also requires a field the real provider never sends.

## 27. A rule added to one path but missing from its siblings

When a diff adds a guard, token, prefix, option, or step to one path, search for parallel paths that need the same change. Examples: other record pools, allow lists, recovery sweeps beside live webhooks, send queues beside queue checks, calls beside texts, alternate hosted URL paths, admin actions beside user actions, recurring items beside one-off ones, create flows beside new edit controls, and test or child environments beside the app. Tests of the edited path will not catch the sibling.

Example: Open breaks are counted as unpaid time when a worker clocks out, but not when an admin closes the shift.

## 28. One failure, deadline, or slow step must not end unrelated work

Check error handling that turns one item's failure into a global state, returns early from a pass that also runs alerts or sends, or stops polling on any error. A per-item 403, provider timeout, or queue deadline should skip to the next item or phase. A timeout sweep must fail only expired rows, not fresh ones just queued. Keep slow bulk writes out of the transaction that holds the important changes.

Example: A timeout sweep fails every pending row once one expires, dropping a greeting that was queued seconds earlier.

## 29. Response headers, cached failure bodies, and proxied redirects

When a handler serving user or scraped content sets its own Content-Security-Policy, check for a framework-wide catch-all CSP that wins unless the route is exempt. Redirects whose target depends on a toggleable flag need private, no-store caching. When a lookup that guards payment or routing throws, return an uncached error, never the normal cacheable body. A proxy that follows a redirect must pass it to the browser, not serve the body at the requested path, or relative imports break.

Example: A lookup error returns the default page with a long CDN cache, so payments keep routing to the wrong merchant.

## 30. Connect, switch, and primary-role changes must keep intent and one source

Trace reconnect to the same property, switching properties, and reconnect after a failed connect. An admin's opt-out must survive reconnect, and reuse matching needs signals that survive a domain move. Disconnect must remove access granted on rows not linked to the connection, and must not delete a copy the owner cannot see. Single-holder roles (main, primary) must demote others and promote exactly one, preferring domain-level over URL-prefix properties. Retire legacy data only once the reader uses the new source.

Example: Disconnect promotes every backup connection to primary and leaves the app's service account with editor access.

## 31. External API answers: missing fields, 409s, and round-trip parts

Before a read-modify-write of an external list, refuse when the read lacks the field instead of treating it as empty. Protobuf JSON omits empty arrays, so test fakes that send [] hide dropped data. When a 409 counts as success, read and correct the existing resource. When an API requires streamed parts to be sent back unchanged across tool rounds, such as model reasoning blocks, keep and merge every fragment, including signature-only fragments with no id or index.

Example: A read returns no owners field. The code writes back a one-entry owners list, removing everyone else.

## 32. Session checks and own-host requests must mirror the real paths

A new heartbeat, status route, or guard that compares session fields must apply the main session verifier's exceptions, such as impersonation tokens minted without a version field. Otherwise it shows false session-ended screens. The OAuth callback address must come from the same value at authorization and at token exchange. URLs sent to external providers must use the property's own host, keeping www and bare domains distinct. Server fetches of the app's own public pages, including fallbacks, must send any internal header the app requires.

Example: Authorization builds the callback from a forwarded host header but token exchange uses the request origin, so login fails behind a proxy.

## 33. Analytics redaction must catch every token shape and every hit

For code that scrubs page URLs, referrers, or query params, test trailing slashes, short codes under the generic length threshold, and UUIDs or other hyphenated tokens. Confirm the generic rule catches what path-specific rules miss. Check that later hits are scrubbed too: automatic page-view tracking on single-page apps can send the raw browser URL after the first configured hit.

Example: Redaction catches /pay/abc123 but not /pay/abc123/, and later in-app navigations send the secret query string unscrubbed.

## 34. Apply filters before take limits or page caps

When a query takes the newest N rows or a page of work and then filters in code, check whether rows that never qualify can fill the cap. Handled items, already-sent items, or other users' records crowd out the rows that matter, so neglected work never surfaces and deadlines pass. Push the filter into the query, or select only rows that can still need work.

Example: A job takes the 300 newest records and then drops handled ones, so older unhandled records never appear.

## 35. Link rewrites must not clobber each other, and clears must persist

When code swaps URLs with global string replacement, check that a shorter stored URL cannot match inside a longer one. Replace the longest first, or match whole attributes. Check the order of rewrite passes: a later pass must not rewrite links an earlier pass injected, and neutralizing links must run after the swap that needs them. Clearing a field must save a removal, not fall back to the last saved value, and must survive the panel remounting.

Example: Replacing https://a.example/book also rewrites part of https://a.example/book/gift, breaking the gift link.

## 36. Counts and coverage must reflect real data, counted once each

Flag defaults that treat a missing marker as full coverage, reports that stopped early but show zero problems, and gates reading a field nothing writes. No rows after a sync finished means zero, not loading. Polling must stop on what the producer actually writes. Exclude cancelled and deleted records from every derived window, and gate minimum counts per metric. Include the week overlapping a range start, classify a whole restored step stack, and ignore same-page anchors in click trackers.

Example: A dashboard stays on loading forever because the provider returned no rows after the sync completed.

## 37. Build, parse, render, and preview must share one format and source

When one step builds a string and another parses, renders, or previews it, check that both use the same helper. Examples: country dial codes on pasted phone numbers (no doubled prefix), text sanitizing for PDFs, and previews that match the final output.

Example: A pasted +44 number gets the dial code added again, becoming +44 +44.

## 38. Text heuristics and restored state need variant tests

Test regex and stemming changes on short words (card becoming car), a leading The, and multi-word durations. Restored steps must still be in the current list, and in-flight loads must not overwrite a newer choice the user made.

Example: A stemmer turns card into car and matches the wrong service.
