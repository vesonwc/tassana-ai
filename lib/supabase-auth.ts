import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient, User } from "@supabase/supabase-js";

// Session-scoped client (anon key + user cookies): reads go through RLS,
// so a site_user can only ever see their own site's rows (ADR-010).
export async function getSessionClient(): Promise<SupabaseClient> {
  const cookieStore = await cookies();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) throw new Error("Missing Supabase env vars");
  return createServerClient(url, anon, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server components cannot set cookies; middleware handles refresh.
        }
      },
    },
  });
}

export interface Profile {
  id: string;
  role: "admin" | "site_user";
  site_id: string | null;
  display_name: string | null;
}

export async function getUserAndProfile(): Promise<{
  user: User;
  profile: Profile;
} | null> {
  const supabase = await getSessionClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase
    .from("profiles")
    .select("id, role, site_id, display_name")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile) return null;
  return { user, profile: profile as Profile };
}
