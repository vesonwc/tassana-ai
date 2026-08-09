import { v7 as uuidv7 } from "uuid";
import type { NormalizedEvent, SourceType } from "@/lib/types";
import {
  extractHikvisionCameraRef,
  normalizeHikvisionEvent,
  type NormalizeContext,
} from "@/lib/normalizers/hikvision";
import {
  extractManualCameraRef,
  normalizeManualEvent,
} from "@/lib/normalizers/manual";

// Every payload entering the system goes through here (rule #1 in CLAUDE.md).
// M1 supports hikvision_isapi only; other adapters are added per milestone.

export function detectSourceType(
  payload: Record<string, unknown>,
): SourceType | null {
  // Test payloads may declare their source explicitly.
  const declared = payload.test_source;
  if (
    declared === "hikvision_isapi" ||
    declared === "dahua" ||
    declared === "onvif" ||
    declared === "frigate" ||
    declared === "manual"
  ) {
    return declared;
  }
  // Hikvision EventNotificationAlert always carries eventType.
  if (typeof payload.eventType === "string") return "hikvision_isapi";
  return null;
}

export function extractCameraRef(
  sourceType: SourceType,
  payload: Record<string, unknown>,
): string | null {
  if (sourceType === "hikvision_isapi") {
    return extractHikvisionCameraRef(payload);
  }
  if (sourceType === "manual") {
    return extractManualCameraRef(payload);
  }
  return null;
}

// Undetectable payloads still become events ("unknown", raw preserved) so
// nothing is silently dropped — but tagged "manual" since no adapter owns them.
function normalizeUnknown(
  payload: Record<string, unknown>,
  ctx: NormalizeContext,
): NormalizedEvent {
  return {
    event_id: uuidv7(),
    site_id: ctx.siteId,
    camera_id: ctx.cameraId,
    source_type: "manual",
    source_raw_id: null,
    event_type: "unknown",
    occurred_at: ctx.receivedAt,
    received_at: ctx.receivedAt,
    detection: { label: null, confidence: null, zone: null, plate: null, bbox: null },
    media: { snapshot_path: null, clip_path: null, clip_status: "none" },
    ai: { verified: null, severity: null, description_th: null, model: null, processed_at: null },
    raw: payload,
  };
}

export function normalizeEvent(
  payload: Record<string, unknown>,
  ctx: NormalizeContext,
): NormalizedEvent {
  const sourceType = detectSourceType(payload);
  switch (sourceType) {
    case "hikvision_isapi":
      return normalizeHikvisionEvent(payload, ctx);
    case "manual":
      return normalizeManualEvent(payload, ctx);
    default:
      return normalizeUnknown(payload, ctx);
  }
}
