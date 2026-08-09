import { describe, expect, it } from "vitest";
import { normalizeManualEvent } from "@/lib/normalizers/manual";
import { detectSourceType, extractCameraRef, normalizeEvent } from "@/lib/normalize";

const CTX = {
  siteId: "019889a0-0000-7000-8000-000000000001",
  cameraId: "cam-pocket3-uuid",
  receivedAt: "2026-08-09T15:00:05+07:00",
};

const AGENT_PAYLOAD = {
  test_source: "manual",
  event_type: "unknown",
  camera_ref: "pocket3",
  occurred_at: "2026-08-09T15:00:00+07:00",
  snapshot_path: "dev/pocket3/2026-08-09T15-00-00.jpg",
  raw_id: "0e8f8a3c-1111-2222-3333-444444444444",
  note: "motion 12.3%",
};

describe("manual adapter (PC agent payloads)", () => {
  it("dispatches manual payloads to the manual normalizer with camera ref", () => {
    expect(detectSourceType(AGENT_PAYLOAD)).toBe("manual");
    expect(extractCameraRef("manual", AGENT_PAYLOAD)).toBe("pocket3");
    const event = normalizeEvent(AGENT_PAYLOAD, CTX);
    expect(event.source_type).toBe("manual");
    expect(event.camera_id).toBe(CTX.cameraId);
  });

  it("keeps snapshot_path, raw_id, occurred_at and full raw payload", () => {
    const event = normalizeManualEvent(AGENT_PAYLOAD, CTX);
    expect(event.media.snapshot_path).toBe("dev/pocket3/2026-08-09T15-00-00.jpg");
    expect(event.source_raw_id).toBe(AGENT_PAYLOAD.raw_id);
    expect(event.occurred_at).toBe("2026-08-09T15:00:00+07:00");
    expect(event.raw).toEqual(AGENT_PAYLOAD);
    expect(event.ai.verified).toBeNull();
  });

  it("declared event types pass through; invalid ones become unknown", () => {
    expect(
      normalizeManualEvent({ ...AGENT_PAYLOAD, event_type: "person_detected" }, CTX)
        .event_type,
    ).toBe("person_detected");
    expect(
      normalizeManualEvent({ ...AGENT_PAYLOAD, event_type: "alien_invasion" }, CTX)
        .event_type,
    ).toBe("unknown");
    expect(normalizeManualEvent({ test_source: "manual" }, CTX).event_type).toBe(
      "unknown",
    );
  });

  it("bad occurred_at falls back to received_at; missing fields become null", () => {
    const event = normalizeManualEvent(
      { test_source: "manual", occurred_at: "yesterday-ish" },
      CTX,
    );
    expect(event.occurred_at).toBe(CTX.receivedAt);
    expect(event.media.snapshot_path).toBeNull();
    expect(event.source_raw_id).toBeNull();
  });
});
