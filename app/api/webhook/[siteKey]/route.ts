import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { detectSourceType, extractCameraRef, normalizeEvent } from "@/lib/normalize";
import { buildAlertFlex, pushLineMessage } from "@/lib/line";
import { TYPE_TH } from "@/lib/labels";
import type { EventType } from "@/lib/types";

export const runtime = "nodejs";

const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ?? "https://tassana-ai.vercel.app";

// Alert-first (ADR-005 taken to its conclusion): these event types ring LINE
// immediately with the raw image — the AI description follows seconds later.
// The bell must never wait for the detective.
const RAW_ALERT_TYPES: EventType[] = ["intrusion", "line_crossing"];

// Event gateway (mode A, no-box): NVR/camera posts here with its secret siteKey.
// Flow: verify siteKey → normalize → insert (idempotent) → enqueue pgmq.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ siteKey: string }> },
) {
  const { siteKey } = await params;
  const supabase = getServiceClient();

  const { data: site, error: siteError } = await supabase
    .from("sites")
    .select("id, status, name, line_group_id, rules")
    .eq("site_key", siteKey)
    .maybeSingle();

  if (siteError) {
    console.error("webhook: site lookup failed", siteError);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
  if (!site) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    const body = await request.json();
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("payload must be a JSON object");
    }
    payload = body as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const receivedAt = new Date().toISOString();

  // Any webhook hit proves the site link is alive.
  void supabase
    .from("sites")
    .update({ heartbeat_at: receivedAt })
    .eq("id", site.id)
    .then(({ error }) => {
      if (error) console.error("webhook: heartbeat update failed", error);
    });

  // Resolve camera by the device-side channel reference, if we know it.
  let cameraId: string | null = null;
  let cameraEnabled = true;
  let cameraName: string | null = null;
  const sourceType = detectSourceType(payload);
  const cameraRef = sourceType ? extractCameraRef(sourceType, payload) : null;
  if (sourceType && cameraRef) {
    const { data: camera } = await supabase
      .from("cameras")
      .select("id, enabled, name")
      .eq("site_id", site.id)
      .eq("source_type", sourceType)
      .eq("source_camera_ref", cameraRef)
      .maybeSingle();
    if (camera) {
      cameraId = camera.id;
      cameraEnabled = camera.enabled !== false;
      cameraName = camera.name;
    } else {
      // Auto-register (ADR-011): first event from an unknown channel creates
      // the camera row, switched OFF — it shows up in settings as "ตรวจพบใหม่"
      // waiting for someone to flip the paid switch.
      const { data: created } = await supabase
        .from("cameras")
        .insert({
          site_id: site.id,
          name: `กล้องช่อง ${cameraRef} (ตรวจพบใหม่)`,
          source_type: sourceType,
          source_camera_ref: cameraRef,
          enabled: false,
        })
        .select("id")
        .maybeSingle();
      cameraId = created?.id ?? null;
      cameraEnabled = false;
    }
    if (cameraId) {
      // Per-camera heartbeat: a single dead channel among 32 must not hide
      // behind the site-level pulse.
      void supabase
        .from("cameras")
        .update({ last_event_at: receivedAt })
        .eq("id", cameraId)
        .then(({ error }) => {
          if (error) console.error("webhook: camera heartbeat failed", error);
        });
    }
  }

  const event = normalizeEvent(payload, {
    siteId: site.id,
    cameraId,
    receivedAt,
  });

  // Idempotency: the partial unique index (site_id, source_type, source_raw_id)
  // rejects re-posts of the same device alarm; PostgREST upsert cannot target a
  // partial index, so insert and treat unique_violation as "duplicate".
  const { error: insertError } = await supabase.from("events").insert(event);

  if (insertError) {
    if (insertError.code === "23505") {
      return NextResponse.json(
        { ok: true, duplicate: true, event_id: null },
        { status: 200 },
      );
    }
    console.error("webhook: event insert failed", insertError);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }

  // Alert-first: ring LINE with the raw image NOW; the AI verdict follows.
  const siteRules = (site.rules ?? {}) as { alerts?: Record<string, boolean> };
  if (
    cameraEnabled &&
    site.line_group_id &&
    RAW_ALERT_TYPES.includes(event.event_type) &&
    siteRules.alerts?.[event.event_type] !== false
  ) {
    try {
      let imageUrl: string | null = null;
      if (event.media.snapshot_path) {
        const { data: signed } = await supabase.storage
          .from("snapshots")
          .createSignedUrl(event.media.snapshot_path, 86_400);
        imageUrl = signed?.signedUrl ?? null;
      }
      const flex = buildAlertFlex({
        severity: "critical",
        eventTypeTh: TYPE_TH[event.event_type] ?? event.event_type,
        descriptionTh: "🚨 แจ้งเตือนด่วนจากกล้อง — AI กำลังวิเคราะห์ภาพ ผลจะตามมาในไม่กี่วินาที",
        cameraName: cameraName ?? `กล้องช่อง ${cameraRef ?? "?"}`,
        siteName: site.name,
        timeTh: `${new Date(event.occurred_at).toLocaleTimeString("th-TH", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit" })} น.`,
        imageUrl,
        dashboardUrl: `${APP_URL}/dashboard/sites/${site.id}`,
      });
      const sent = await pushLineMessage(site.line_group_id, [flex]);
      if (sent.ok) {
        await supabase.from("alerts").insert({
          event_id: event.event_id,
          channel: "line",
          sent_at: new Date().toISOString(),
        });
      } else {
        console.error("webhook: raw LINE alert failed", sent.error);
      }
    } catch (err) {
      // The bell must never break event ingestion.
      console.error("webhook: raw alert error", (err as Error).message);
    }
  }

  // Disabled camera (ADR-011): event recorded for history, but no analysis
  // and no alert — the switch is the billing boundary.
  if (cameraEnabled) {
    const { error: enqueueError } = await supabase.rpc("enqueue_event", {
      p_event_id: event.event_id,
    });
    if (enqueueError) {
      // Event row exists; worker reconciliation will pick it up. Do not fail the
      // device's callback — most NVRs treat non-2xx as "retry forever".
      console.error("webhook: enqueue failed", enqueueError);
    }
  }

  return NextResponse.json(
    { ok: true, duplicate: false, event_id: event.event_id },
    { status: 201 },
  );
}
