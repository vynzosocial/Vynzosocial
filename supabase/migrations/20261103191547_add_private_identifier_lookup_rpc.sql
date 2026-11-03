CREATE OR REPLACE FUNCTION public.get_vynzo_id(target_user_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT identifier.vynzo_id
  FROM vynzo_private.user_identifiers AS identifier
  WHERE identifier.user_id = target_user_id;
$$;

REVOKE ALL ON FUNCTION public.get_vynzo_id(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_vynzo_id(uuid) TO service_role;