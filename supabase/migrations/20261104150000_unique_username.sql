-- Enforce unique usernames (case-insensitive) at the database level.
-- Skipped with a notice if duplicates already exist, so the push never fails.
DO $$
BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_key ON public.users (lower(username));
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'Duplicate usernames exist; resolve them, then re-run this index creation.';
END $$;

CREATE OR REPLACE FUNCTION public.is_username_available(candidate text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM public.users WHERE lower(username) = lower(btrim(candidate))
  );
$$;

REVOKE ALL ON FUNCTION public.is_username_available(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_username_available(text) TO anon, authenticated, service_role;
