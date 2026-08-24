-- The legacy exam Edge Function uses the service role through PostgREST. A
-- prior hardening migration removed EXECUTE on this immutable normalizer,
-- causing every scheduled legacy exam sync to fail before importing details.
grant execute on function public.exam_norm(text) to service_role;
