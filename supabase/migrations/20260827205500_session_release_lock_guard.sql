begin;

-- Candidate-login cleanup may race a heartbeat or replacement claim for the
-- same lease row. Releasing a session remains best-effort, so do not let that
-- cleanup occupy a connection until the project-wide statement timeout.
alter function session_private.app_session_release()
  set lock_timeout='750ms';

commit;
