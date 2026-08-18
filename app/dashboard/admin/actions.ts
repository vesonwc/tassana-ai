"use server";

import { randomBytes, randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getUserAndProfile } from "@/lib/supabase-auth";
import { getServiceClient } from "@/lib/supabase";

async function requireAdmin(): Promise<void> {
  const session = await getUserAndProfile();
  if (!session || session.profile.role !== "admin") {
    throw new Error("admin only");
  }
}

export async function createSite(formData: FormData): Promise<void> {
  await requireAdmin();
  const name = String(formData.get("name") ?? "").trim();
  const templateId = String(formData.get("templateId") ?? "");
  if (!name) return;

  const siteKey = `sk_${randomUUID().replace(/-/g, "")}`;
  const service = getServiceClient();
  const { data: site, error } = await service
    .from("sites")
    .insert({ name, site_key: siteKey, template_id: templateId || null })
    .select("id")
    .maybeSingle();
  if (error || !site) throw new Error(`create site failed: ${error?.message}`);

  redirect(`/dashboard/sites/${site.id}/settings?tab=connect`);
}

export async function rotateSiteKey(formData: FormData): Promise<void> {
  await requireAdmin();
  const siteId = String(formData.get("siteId") ?? "");
  if (!siteId) return;
  const service = getServiceClient();
  await service
    .from("sites")
    .update({ site_key: `sk_${randomUUID().replace(/-/g, "")}` })
    .eq("id", siteId);
  revalidatePath(`/dashboard/sites/${siteId}/settings`);
}

export async function saveLineTarget(formData: FormData): Promise<void> {
  await requireAdmin();
  const siteId = String(formData.get("siteId") ?? "");
  const target = String(formData.get("lineTarget") ?? "").trim();
  if (!siteId) return;
  const service = getServiceClient();
  await service
    .from("sites")
    .update({ line_group_id: target || null })
    .eq("id", siteId);
  revalidatePath(`/dashboard/sites/${siteId}/settings`);
  redirect(`/dashboard/sites/${siteId}/settings?tab=connect&saved=1`);
}

export interface CreateUserState {
  error?: string;
  email?: string;
  password?: string;
}

export async function createUser(
  _prev: CreateUserState,
  formData: FormData,
): Promise<CreateUserState> {
  await requireAdmin();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const siteId = String(formData.get("siteId") ?? "");
  const role = formData.get("role") === "admin" ? "admin" : "site_user";
  if (!email) return { error: "กรอกอีเมลก่อนครับ" };
  if (role === "site_user" && !siteId) return { error: "เลือกโครงการให้ผู้ใช้ด้วยครับ" };

  const password = `Tsn-${randomBytes(9).toString("base64").replace(/[+/=]/g, "x")}`;
  const service = getServiceClient();
  const { data: created, error } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !created.user) {
    return { error: `สร้างไม่สำเร็จ: ${error?.message ?? "unknown"}` };
  }
  const { error: profileError } = await service.from("profiles").insert({
    id: created.user.id,
    role,
    site_id: role === "admin" ? null : siteId,
  });
  if (profileError) {
    return { error: `สร้างสิทธิ์ไม่สำเร็จ: ${profileError.message}` };
  }
  return { email, password };
}

// Permanently remove a site and everything attached to it. Cameras, events,
// alerts, reports and knowledge disappear by cascade; snapshot files are not
// covered by the database cascade, so they are removed explicitly first.
// Guarded by typing the site name — this cannot be undone.
export async function deleteSite(formData: FormData): Promise<void> {
  await requireAdmin();
  const siteId = String(formData.get("siteId") ?? "");
  const typed = String(formData.get("confirmName") ?? "").trim();
  if (!siteId) return;
  const service = getServiceClient();

  const { data: site } = await service
    .from("sites")
    .select("name")
    .eq("id", siteId)
    .maybeSingle();
  if (!site) return;
  if (typed !== site.name.trim()) {
    redirect(`/dashboard/sites/${siteId}/settings?tab=connect&delete=name-mismatch`);
  }

  // Storage first: once the rows are gone we can no longer find the paths.
  const paths: string[] = [];
  for (let from = 0; ; from += 1000) {
    const { data: batch } = await service
      .from("events")
      .select("media")
      .eq("site_id", siteId)
      .range(from, from + 999);
    if (!batch || batch.length === 0) break;
    for (const row of batch) {
      const p = (row as { media?: { snapshot_path?: string | null } }).media?.snapshot_path;
      if (p) paths.push(p);
    }
    if (batch.length < 1000) break;
  }
  for (let i = 0; i < paths.length; i += 100) {
    const { error } = await service.storage.from("snapshots").remove(paths.slice(i, i + 100));
    if (error) console.error("deleteSite: storage remove failed", error.message);
  }

  const { error } = await service.from("sites").delete().eq("id", siteId);
  if (error) throw new Error(`delete site failed: ${error.message}`);
  revalidatePath("/dashboard");
  redirect("/dashboard?deleted=1");
}
