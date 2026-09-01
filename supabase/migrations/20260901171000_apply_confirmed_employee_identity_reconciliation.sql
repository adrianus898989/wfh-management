begin;

set local lock_timeout = '5s';
set local statement_timeout = '240s';

-- Phase A precompiled and privilege-isolated the complete fail-closed
-- reconciliation. Keeping this ordered phase to one function call prevents
-- long employee/scope/cache work from sharing a transaction with hot-table
-- schema locks.
select employee_private.apply_confirmed_employee_identity_reconciliation();

commit;
