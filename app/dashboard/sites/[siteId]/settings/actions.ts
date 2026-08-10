"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSessionClient } from "@/lib/supabase-auth";
import { getServiceClient } from "@/lib/supabase";

const ALERTABLE_TYPES = [
  "person_detected",
  "vehicle_detected",
  "line_crossing",
  "intrusion",
  "loitering",
  "lpr",
  "camera_offline",
] as const;

// Site rules (ADR-010 rule 4). Consumed by LINE delivery when M2 lands.
export async function saveSiteRules(formData: FormData): Promise<void> {
  const siteId = String(formData.get("siteId") ?? "");
  if (!siteId) return;

  const session = await getSessionClient();
  const { data: visible } = await session
    .from("sites")
    .select("id")
    .eq("id", siteId)
    .maybeSingle();
  if (!visible) return;

  const alerts: Record<string, boolean> = {};
  for (const type of ALERTABLE_TYPES) {
    alerts[type] = formData.get(`alert_${type}`) === "on";
  }

  const sensitivity = String(formData.get("sensitivity") ?? "medium");
  const rules = {
    alerts,
    strict_hours: {
      start: String(formData.get("strict_start") ?? "22:00"),
      end: String(formData.get("strict_end") ?? "06:00"),
    },
    sensitivity: ["high", "medium", "low"].includes(sensitivity)
      ? sensitivity
      : "medium",
  };

  // Layer-3 instruction (ADR-011): plain Thai, straight into the VLM prompt.
  const siteInstructions = String(formData.get("site_instructions") ?? "").trim();

  const service = getServiceClient();
  await service
    .from("sites")
    .update({ rules, custom_instructions_th: siteInstructions || null })
    .eq("id", siteId);

  revalidatePath(`/dashboard/sites/${siteId}/settings`);
  redirect(`/dashboard/sites/${siteId}/settings?saved=1`);
}

// Per-camera config (ADR-011): role profile, enable switch, and plain-Thai
// instructions — all data, no deploy.
export async function saveCameraConfig(formData: FormData): Promise<void> {
  const cameraId = String(formData.get("cameraId") ?? "");
  const siteId = String(formData.get("siteId") ?? "");
  if (!cameraId) return;

  const session = await getSessionClient();
  const { data: visible } = await session
    .from("cameras")
    .select("id")
    .eq("id", cameraId)
    .maybeSingle();
  if (!visible) return;

  const profileId = String(formData.get("profileId") ?? "");
  const instructions = String(formData.get("instructions") ?? "").trim();

  const service = getServiceClient();
  await service
    .from("cameras")
    .update({
      enabled: formData.get("enabled") === "on",
      profile_id: profileId || null,
      custom_instructions_th: instructions || null,
    })
    .eq("id", cameraId);

  revalidatePath(`/dashboard/sites/${siteId}/settings`);
  redirect(`/dashboard/sites/${siteId}/settings?saved=1`);
}
