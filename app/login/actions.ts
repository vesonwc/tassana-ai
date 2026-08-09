"use server";

import { redirect } from "next/navigation";
import { getSessionClient } from "@/lib/supabase-auth";

export async function signIn(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const supabase = await getSessionClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    redirect("/login?error=1");
  }
  redirect("/dashboard");
}

export async function signOut(): Promise<void> {
  const supabase = await getSessionClient();
  await supabase.auth.signOut();
  redirect("/login");
}
