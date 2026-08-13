"use server";

import { revalidatePath } from "next/cache";
import { getServiceClient } from "@/lib/supabase";

// Feedback per event (ADR-008: false-alarm labels are the system's most
// valuable data). Stored on the alerts row for the event — created on first
// feedback if LINE delivery (M2) hasn't produced one yet.
export async function submitFeedback(formData: FormData): Promise<void> {
  const adminKey = String(formData.get("adminKey") ?? "");
  const eventId = String(formData.get("eventId") ?? "");
  const feedback = String(formData.get("feedback") ?? "");

  const expected = process.env.ADMIN_DASH_KEY;
  if (!expected || adminKey !== expected) return;
  if (feedback !== "false_alarm" && feedback !== "confirmed") return;
  if (!eventId) return;

  const supabase = getServiceClient();
  const now = new Date().toISOString();

  const { data: existingRows } = await supabase
    .from("alerts")
    .select("id")
    .eq("event_id", eventId)
    .order("sent_at", { ascending: true, nullsFirst: false })
    .limit(1);
  const existing = existingRows?.[0] ?? null;

  if (existing) {
    await supabase
      .from("alerts")
      .update({ feedback, feedback_by: "admin_dash", feedback_at: now })
      .eq("id", existing.id);
  } else {
    await supabase.from("alerts").insert({
      event_id: eventId,
      channel: "line",
      feedback,
      feedback_by: "admin_dash",
      feedback_at: now,
    });
  }

  revalidatePath(`/admin/${adminKey}/events`);
}
