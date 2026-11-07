CREATE OR REPLACE FUNCTION public.delete_ended_live_session()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  DELETE FROM public.live_sessions WHERE id = NEW.id;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.delete_ended_live_session() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_ended_live_session() TO service_role;

DROP TRIGGER IF EXISTS delete_ended_live_session ON public.live_sessions;
CREATE TRIGGER delete_ended_live_session
AFTER UPDATE OF is_active ON public.live_sessions
FOR EACH ROW
WHEN (OLD.is_active IS TRUE AND NEW.is_active IS FALSE)
EXECUTE FUNCTION public.delete_ended_live_session();
