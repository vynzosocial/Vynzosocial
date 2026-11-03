CREATE OR REPLACE FUNCTION vynzo_private.handle_vynzo_auth_user_created()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  profile jsonb := NEW.raw_user_meta_data;
  username_value text := pg_catalog.lower(pg_catalog.btrim(profile ->> 'username'));
  first_name_value text := pg_catalog.btrim(profile ->> 'first_name');
  last_name_value text := pg_catalog.btrim(profile ->> 'last_name');
  nationality_value text := pg_catalog.btrim(profile ->> 'nationality');
  birth_date_value date;
BEGIN
  IF profile ->> 'vynzo_profile_version' IS DISTINCT FROM '1' THEN
    RETURN NEW;
  END IF;

  IF username_value IS NULL
     OR username_value !~ '^[a-zA-Z0-9](?:[a-zA-Z0-9._]{1,28}[a-zA-Z0-9])$'
     OR NEW.email IS NULL THEN
    RAISE EXCEPTION 'Invalid username' USING ERRCODE = '23514';
  END IF;
  IF first_name_value IS NULL OR first_name_value = '' OR pg_catalog.length(first_name_value) > 60
     OR last_name_value IS NULL OR last_name_value = '' OR pg_catalog.length(last_name_value) > 60
     OR nationality_value IS NULL OR nationality_value = '' OR pg_catalog.length(nationality_value) > 80 THEN
    RAISE EXCEPTION 'Invalid profile details' USING ERRCODE = '23514';
  END IF;
  IF profile ->> 'age_confirmed' IS DISTINCT FROM 'true'
     OR profile ->> 'terms_accepted' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'Age confirmation and terms acceptance are required' USING ERRCODE = '23514';
  END IF;

  BEGIN
    birth_date_value := (profile ->> 'birth_date')::date;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Invalid birth date' USING ERRCODE = '23514';
  END;
  IF birth_date_value IS NULL
     OR birth_date_value > CURRENT_DATE
     OR birth_date_value > (CURRENT_DATE - INTERVAL '18 years')::date THEN
    RAISE EXCEPTION 'Vynzo accounts require an age of 18 or older' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(username_value, 0));
  IF EXISTS (
    SELECT 1
    FROM public.users AS existing_user
    WHERE pg_catalog.lower(existing_user.username) = username_value
  ) THEN
    RAISE EXCEPTION 'Username already in use' USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.users (
    id, username, email, display_name, age_confirmed_at, terms_accepted_at, terms_version,
    first_name, last_name, birth_date, nationality
  )
  VALUES (
    NEW.id, username_value, NEW.email, first_name_value || ' ' || last_name_value,
    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, '2026-11-01',
    first_name_value, last_name_value, birth_date_value, nationality_value
  );

  INSERT INTO vynzo_private.user_identifiers (user_id)
  VALUES (NEW.id);

  NEW.raw_user_meta_data := profile - ARRAY[
    'vynzo_profile_version', 'first_name', 'last_name', 'birth_date',
    'nationality', 'age_confirmed', 'terms_accepted'
  ]::text[];

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION vynzo_private.handle_vynzo_auth_user_created() FROM PUBLIC, anon, authenticated;

GRANT USAGE ON SCHEMA public, vynzo_private TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON vynzo_private.user_identifiers TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO service_role;

DROP TRIGGER IF EXISTS before_vynzo_auth_user_insert ON auth.users;
CREATE TRIGGER before_vynzo_auth_user_insert
  BEFORE INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION vynzo_private.handle_vynzo_auth_user_created();