import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://qyfphwrmwvnwsklfsbbo.supabase.co';
// Publishable key: safe for the browser. Never put the service_role key here.
const SUPABASE_KEY = 'sb_publishable_i-NMgPe43-Tt-Afc9aQXoQ_dsBx6RwR';

export const supabaseClient = createClient(SUPABASE_URL, SUPABASE_KEY);
