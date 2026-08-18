// Central event schema — mirror of docs/event-schema.md.
// Any change here requires an ADR in docs/decisions.md first.

export type EventType =
  | "person_detected"
  | "vehicle_detected"
  | "line_crossing"
  | "intrusion"
  | "loitering"
  | "lpr"
  | "camera_offline"
  | "camera_online"
  | "unknown";

export type SourceType =
  | "hikvision_isapi"
  | "dahua"
  | "onvif"
  | "frigate"
  | "manual";

export type ClipStatus = "none" | "pending" | "ready" | "failed";

export type Severity = "info" | "warning" | "critical";

export interface Detection {
  label: string | null;
  confidence: number | null;
  zone: string | null;
  plate: string | null;
  bbox: [number, number, number, number] | null;
}

export interface Media {
  snapshot_path: string | null;
  clip_path: string | null;
  clip_status: ClipStatus;
}

// ADR-015: what the on-worker object detector saw before the VLM ran.
export interface DetectorSummary {
  model: string; // e.g. "yolox_s"
  mode: "shadow" | "gate";
  ms: number;
  objects: { label: string; confidence: number; bbox: [number, number, number, number] }[]; // bbox normalized 0-1
  gate: "analyze" | "skip" | "would-skip"; // would-skip = shadow mode verdict
  reason: string;
}

export interface AiResult {
  verified: boolean | null;
  severity: Severity | null;
  description_th: string | null;
  model: string | null;
  processed_at: string | null;
  detector?: DetectorSummary | null;
}

export interface NormalizedEvent {
  event_id: string;
  site_id: string;
  camera_id: string | null;
  source_type: SourceType;
  source_raw_id: string | null;
  event_type: EventType;
  occurred_at: string;
  received_at: string;
  detection: Detection;
  media: Media;
  ai: AiResult;
  raw: Record<string, unknown>;
}
