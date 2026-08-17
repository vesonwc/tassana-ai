import { v7 as uuidv7 } from "uuid";
import type { EventType, NormalizedEvent } from "@/lib/types";

// Hikvision ISAPI EventNotificationAlert → NormalizedEvent.
// Mapping per docs/event-schema.md. Anything unrecognized becomes "unknown"
// with the raw payload preserved — never dropped.
const HIKVISION_EVENT_MAP: Record<string, EventType> = {
  linedetection: "line_crossing",
  fielddetection: "intrusion",
  loitering: "loitering",
  vehicledetection: "lpr",
  anpr: "lpr",
  videoloss: "camera_offline",
  // Our own scheduled walk-round snapshot (see nvr-listener night patrol) —
  // rides the same pipe as a plain detection so nothing special is needed.
  patrol: "person_detected",
  vmd: "person_detected",
};

export interface NormalizeContext {
  siteId: string;
  cameraId: string | null;
  receivedAt: string; // ISO8601
}

// Real NVRs speak XML (EventNotificationAlert). Tolerant tag extraction beats
// strict parsing here — firmware variants differ, and we keep the full raw
// XML anyway (ADR-008) so nothing is ever lost to a format surprise.
const XML_FIELDS = [
  "eventType",
  "eventState",
  "dateTime",
  "channelID",
  "dynChannelID",
  "channelName",
  "activePostCount",
  "eventDescription",
  "ipAddress",
  "macAddress",
] as const;

export function parseHikvisionXml(xml: string): Record<string, unknown> {
  const out: Record<string, unknown> = { test_source: "hikvision_isapi" };
  for (const field of XML_FIELDS) {
    const match = xml.match(new RegExp(`<${field}>([^<]*)</${field}>`, "i"));
    if (match && match[1].trim() !== "") out[field] = match[1].trim();
  }
  out._raw_xml = xml.slice(0, 10_000);
  return out;
}

export function looksLikeHikvisionXml(body: string): boolean {
  return /<EventNotificationAlert/i.test(body);
}

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number") return String(value);
  return null;
}

/** Channel reference used to resolve camera_id against the cameras table. */
export function extractHikvisionCameraRef(
  payload: Record<string, unknown>,
): string | null {
  return asString(payload.channelID) ?? asString(payload.dynChannelID);
}

function parseOccurredAt(payload: Record<string, unknown>, fallback: string): string {
  const raw = asString(payload.dateTime);
  if (raw) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return raw;
  }
  // Malformed/missing device time — fail open with our receive time.
  return fallback;
}

// Hikvision has no per-alarm unique id; the NVR re-posts the same alarm with an
// incrementing activePostCount. dateTime+eventType+channel identifies one alarm,
// so retries and re-posts dedupe onto the same source_raw_id.
function buildSourceRawId(payload: Record<string, unknown>): string | null {
  const dateTime = asString(payload.dateTime);
  const eventType = asString(payload.eventType);
  if (!dateTime || !eventType) return null;
  const channel = extractHikvisionCameraRef(payload) ?? "0";
  return `${eventType}:${channel}:${dateTime}`;
}

export function normalizeHikvisionEvent(
  payload: Record<string, unknown>,
  ctx: NormalizeContext,
): NormalizedEvent {
  const hikType = asString(payload.eventType)?.toLowerCase() ?? "";
  const eventType: EventType = HIKVISION_EVENT_MAP[hikType] ?? "unknown";

  const plate =
    eventType === "lpr"
      ? (asString(payload.licensePlate) ?? asString(payload.plateNumber))
      : null;

  return {
    event_id: uuidv7(),
    site_id: ctx.siteId,
    camera_id: ctx.cameraId,
    source_type: "hikvision_isapi",
    source_raw_id: buildSourceRawId(payload),
    event_type: eventType,
    occurred_at: parseOccurredAt(payload, ctx.receivedAt),
    received_at: ctx.receivedAt,
    detection: {
      label: null,
      confidence: null,
      zone: null,
      plate,
      bbox: null,
    },
    media: {
      snapshot_path: null,
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
