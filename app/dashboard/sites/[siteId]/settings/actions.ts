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
  redirect(`/dashboard/sites/${siteId}/settings?tab=alerts&saved=1`);
}

// Layer-4 knowledge (ADR-013): add/remove facts from the dashboard.
export async function addKnowledge(formData: FormData): Promise<void> {
  const siteId = String(formData.get("siteId") ?? "");
  const fact = String(formData.get("fact") ?? "").trim();
  if (!siteId || !fact) return;

  const session = await getSessionClient();
  const { data: visible } = await session
    .from("sites")
    .select("id")
    .eq("id", siteId)
    .maybeSingle();
  if (!visible) return;

  const service = getServiceClient();
  await service.from("site_knowledge").insert({
    site_id: siteId,
    fact_th: fact,
    source: "dashboard",
  });
  revalidatePath(`/dashboard/sites/${siteId}/settings`);
  redirect(`/dashboard/sites/${siteId}/settings?tab=knowledge&saved=1`);
}

export async function deleteKnowledge(formData: FormData): Promise<void> {
  const siteId = String(formData.get("siteId") ?? "");
  const knowledgeId = String(formData.get("knowledgeId") ?? "");
  if (!siteId || !knowledgeId) return;

  const session = await getSessionClient();
  const { data: visible } = await session
    .from("site_knowledge")
    .select("id")
    .eq("id", knowledgeId)
    .maybeSingle();
  if (!visible) return;

  const service = getServiceClient();
  await service.from("site_knowledge").delete().eq("id", knowledgeId);
  revalidatePath(`/dashboard/sites/${siteId}/settings`);
  redirect(`/dashboard/sites/${siteId}/settings?tab=knowledge&saved=1`);
}

// ADR-014: human edits to the learned baseline lock it (worker won't overwrite);
// "unlock" hands it back to the daily learner.
export async function saveBaseline(formData: FormData): Promise<void> {
  const siteId = String(formData.get("siteId") ?? "");
  const cameraId = String(formData.get("cameraId") ?? "");
  const baseline = String(formData.get("baseline") ?? "").trim();
  const unlock = formData.get("unlock") === "1";
  if (!siteId || !cameraId) return;

  const session = await getSessionClient();
  const { data: visible } = await session
    .from("cameras")
    .select("id")
    .eq("id", cameraId)
    .maybeSingle();
  if (!visible) return;

  const service = getServiceClient();
  if (unlock) {
    await service.from("camera_baselines").update({ locked: false }).eq("camera_id", cameraId);
  } else if (baseline) {
    await service.from("camera_baselines").upsert({
      camera_id: cameraId,
      baseline_th: baseline.slice(0, 900),
      locked: true,
      updated_at: new Date().toISOString(),
    });
  } else {
    await service.from("camera_baselines").delete().eq("camera_id", cameraId);
  }
  revalidatePath(`/dashboard/sites/${siteId}/settings`);
  redirect(`/dashboard/sites/${siteId}/settings?tab=knowledge&saved=1`);
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
  redirect(`/dashboard/sites/${siteId}/settings?tab=cameras&saved=1`);
}
