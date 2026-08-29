# staff-full-reconcile v4 recovery candidate

This local-only recovery candidate restores only bounded `银行信息` row writes.
It does not restore the old full-export worker and never writes employee master,
schedule, lifecycle, status, team, position, or compensation data.

- Requests contain at most eight rows and 512 KiB.
- Writes require the hidden `__WFH员工ID` binding and the visible normalized
  name must agree with the current employee record. A historical employee
  number can resolve through one unambiguous lifecycle link, but it is subject
  to the same current-name check; name-only writes are rejected.
- `bank_binding_dry_run` is read-only. It can propose the current employee
  number only when the normalized name occurs exactly once in the entire source
  sheet and exactly once in the employee table. Duplicate, missing, ambiguous,
  stale-binding, and name-mismatch rows are returned as quarantined row results
  without aborting the other rows in the batch.
- The Edge function shares the `staff-sheet-sync` runtime lease with the onsite
  writer and calls one transactional Postgres RPC.
- The RPC has a durable request ledger for both plans and writes, without
  storing source rows or secrets. A replay preserves the original read/write
  result; reused request IDs with a different payload fail.
- Only bank-owned payment fields and the two bank contact mirrors are updated.
- Empty incoming payment/contact/address cells preserve existing non-empty
  values; this recovery path has no delete semantics.
- `export_profile_chunk` and any destructive full-snapshot reconciliation stay
  paused until their trigger/watermark can be independently audited.

This function uses the installed Apps Script secret, so JWT verification must
remain disabled if it is eventually deployed. Deployment is not part of this
patch.

## Safe recovery order

1. Scan the whole source sheet locally and calculate every normalized-name
   occurrence count.
2. Send stable, maximum-eight-row `bank_binding_dry_run` batches. Keep all
   results except `ready` quarantined. Dry-run receipts are the planning ledger.
3. Review the proposed current employee numbers before writing them into the
   hidden source binding column. That source-sheet mutation needs separate
   authorization.
4. Start with one five-row write canary, one request at a time. Reuse the same
   request ID for retries, leave 2-5 seconds between batches, and reconcile
   hashes/counts after every batch.
5. Restore only the bounded edit sender after parity is proven. Do not restore
   the legacy `export_profile_chunk` or large full-reconcile worker.
