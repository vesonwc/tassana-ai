import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { detectSourceType, extractCameraRef, normalizeEvent } from "@/lib/normalize";

export const runtime = "nodejs";

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
    .select("id, status")
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
  const sourceType = detectSourceType(payload);
  const cameraRef = sourceType ? extractCameraRef(sourceType, payload) : null;
  if (sourceType && cameraRef) {
    const { data: camera } = await supabase
      .from("cameras")
      .select("id")
      .eq("site_id", site.id)
      .eq("source_type", sourceType)
      .eq("source_camera_ref", cameraRef)
      .maybeSingle();
    cameraId = camera?.id ?? null;
  }

  const event = normalizeEvent(payload, {
    siteId: site.id,
    cameraId,
    receivedAt,
  });

  // Idempotency: unique (site_id, source_type, source_raw_id) — a duplicate
  // upserts to nothing and must not create a second alert.
  const { data: inserted, error: insertError } = await supabase
    .from("events")
    .upsert(event, {
      onConflict: "site_id,source_type,source_raw_id",
      ignoreDuplicates: true,
    })
    .select("event_id");

  if (insertError) {
    console.error("webhook: event insert failed", insertError);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }

  if (!inserted || inserted.length === 0) {
    return NextResponse.json(
      { ok: true, duplicate: true, event_id: null },
      { status: 200 },
    );
  }

  const { error: enqueueError } = await supabase.rpc("enqueue_event", {
    p_event_id: event.event_id,
  });
  if (enqueueError) {
    // Event row exists; worker reconciliation will pick it up. Do not fail the
    // device's callback — most NVRs treat non-2xx as "retry forever".
    console.error("webhook: enqueue failed", enqueueError);
  }

  return NextResponse.json(
    { ok: true, duplicate: false, event_id: event.event_id },
    { status: 201 },
  );
}
