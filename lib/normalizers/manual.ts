import { v7 as uuidv7 } from "uuid";
import type { EventType, NormalizedEvent } from "@/lib/types";
import type { NormalizeContext } from "@/lib/normalizers/hikvision";

// Manual adapter: events posted by our own tools (PC edge agent, admin actions,
// future integrations without a dedicated adapter). Payload contract:
//   { test_source: "manual", event_type?, camera_ref?, occurred_at?,
//     snapshot_path?, raw_id?, label?, note? }
const VALID_EVENT_TYPES = new Set<EventType>([
  "person_detected",
  "vehicle_detected",
  "line_crossing",
  "intrusion",
  "loitering",
  "lpr",
  "camera_offline",
  "camera_online",
  "unknown",
]);

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return null;
}

export function extractManualCameraRef(
  payload: Record<string, unknown>,
): string | null {
  return asString(payload.camera_ref);
}

export function normalizeManualEvent(
  payload: Record<string, unknown>,
  ctx: NormalizeContext,
): NormalizedEvent {
  const declared = asString(payload.event_type) as EventType | null;
  const eventType: EventType =
    declared && VALID_EVENT_TYPES.has(declared) ? declared : "unknown";

  const occurredRaw = asString(payload.occurred_at);
  const occurredValid =
    occurredRaw !== null && !Number.isNaN(new Date(occurredRaw).getTime());

  return {
    event_id: uuidv7(),
    site_id: ctx.siteId,
    camera_id: ctx.cameraId,
    source_type: "manual",
    source_raw_id: asString(payload.raw_id),
    event_type: eventType,
    occurred_at: occurredValid ? occurredRaw : ctx.receivedAt,
    received_at: ctx.receivedAt,
    detection: {
      label: asString(payload.label),
      confidence: null,
      zone: asString(payload.zone),
      plate: null,
      bbox: null,
    },
    media: {
      snapshot_path: asString(payload.snapshot_path),
      clip_path: null,
      clip_status: "none",
    },
    ai: {
      verified: null,
      severity: null,
      description_th: null,
      model: null,
      processed_at: null,
    },
    raw: payload,
  };
}
