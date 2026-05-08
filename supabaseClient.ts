import { createClient } from "@supabase/supabase-js";

const normalizeSupabaseUrl = (raw?: string): string => {
  const fallback = "https://dhubdhpkugfvqgklxzdl.supabase.co";
  const source = (raw ?? "").trim();
  if (!source) {
    return fallback;
  }

  let normalized = source.replace(/\/+$/, "");
  normalized = normalized.replace(/\/rest\/v1$/i, "");
  normalized = normalized.replace(/\/storage\/v1$/i, "");
  normalized = normalized.replace(/\/auth\/v1$/i, "");

  return normalized || fallback;
};

export const SUPABASE_URL = normalizeSupabaseUrl(process.env.SUPABASE_URL);
export const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
  process.env.SUPABASE_ANON_KEY?.trim() ||
  "sb_publishable_Vm5NiZck3MROCzf1YJXVAw_g8ngEcLE";

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
