"use server";

import { revalidatePath } from "next/cache";
import { getSessionClient } from "@/lib/supabase-auth";
import { getServiceClient } from "@/lib/supabase";

// Feedback write (ADR-010 rule 3): confirm the session can actually see the
// event through RLS, then write with the service client.
export async function submitEventFeedback(formData: FormData): Promise<void> {
  const eventId = String(formData.get("eventId") ?? "");
  const siteId = String(formData.get("siteId") ?? "");
  const feedback = String(formData.get("feedback") ?? "");
  if (!eventId || (feedback !== "false_alarm" && feedback !== "confirmed")) return;

  const session = await getSessionClient();
  const { data: visible } = await session
    .from("events")
    .select("event_id")
    .eq("event_id", eventId)
    .maybeSingle();
  if (!visible) return;

  const service = getServiceClient();
  const now = new Date().toISOString();
  const { data: existing } = await service
    .from("alerts")
    .select("id")
    .eq("event_id", eventId)
    .maybeSingle();

  if (existing) {
    await service
      .from("alerts")
      .update({ feedback, feedback_by: "dashboard", feedback_at: now })
      .eq("id", existing.id);
  } else {
    await service.from("alerts").insert({
      event_id: eventId,
      channel: "line",
      feedback,
      feedback_by: "dashboard",
      feedback_at: now,
    });
  }

  revalidatePath(`/dashboard/sites/${siteId}`);
}
