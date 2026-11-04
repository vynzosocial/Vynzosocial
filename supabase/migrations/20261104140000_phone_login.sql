ALTER TABLE public.users ADD COLUMN IF NOT EXISTS phone text;
CREATE INDEX IF NOT EXISTS users_phone_idx ON public.users (phone) WHERE phone IS NOT NULL;

-- Bring over phone numbers already stored with the Supabase auth accounts.
UPDATE public.users AS u
SET phone = CASE
  WHEN src.raw LIKE '+%' THEN src.raw
  ELSE '+' || src.raw
END
FROM (
  SELECT a.id,
         pg_catalog.regexp_replace(
           COALESCE(NULLIF(a.phone, ''), a.raw_user_meta_data ->> 'phone'), '[\s().-]', '', 'g') AS raw
  FROM auth.users AS a
) AS src
WHERE u.id = src.id
  AND u.phone IS NULL
  AND src.raw ~ '^\+?\d{8,15}$';

CREATE OR REPLACE FUNCTION vynzo_private.copy_auth_phone_to_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  raw_phone text := pg_catalog.regexp_replace(COALESCE(NEW.raw_user_meta_data ->> 'phone', ''), '[\s().-]', '', 'g');
BEGIN
  IF raw_phone ~ '^\+?\d{8,15}$' THEN
    UPDATE public.users
    SET phone = CASE WHEN raw_phone LIKE '+%' THEN raw_phone ELSE '+' || raw_phone END
    WHERE id = NEW.id;
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION vynzo_private.copy_auth_phone_to_profile() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS after_vynzo_auth_user_phone ON auth.users;
CREATE TRIGGER after_vynzo_auth_user_phone
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION vynzo_private.copy_auth_phone_to_profile();
