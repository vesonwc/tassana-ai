import { describe, expect, it } from "vitest";
import { normalizeHikvisionEvent } from "@/lib/normalizers/hikvision";
import { detectSourceType, normalizeEvent } from "@/lib/normalize";

const CTX = {
  siteId: "019889a0-0000-7000-8000-000000000001",
  cameraId: "019889a0-0000-7000-8000-000000000101",
  receivedAt: "2026-08-09T02:14:05+07:00",
};

const GOOD_PAYLOAD = {
  test_source: "hikvision_isapi",
  eventType: "linedetection",
  channelID: "1",
  dateTime: "2026-08-09T02:14:00+07:00",
  activePostCount: "1",
  eventDescription: "linedetection alarm",
};

describe("normalizeHikvisionEvent — good payload", () => {
  it("maps linedetection to line_crossing with all fields", () => {
    const event = normalizeHikvisionEvent(GOOD_PAYLOAD, CTX);

    expect(event.event_type).toBe("line_crossing");
    expect(event.source_type).toBe("hikvision_isapi");
    expect(event.site_id).toBe(CTX.siteId);
    expect(event.camera_id).toBe(CTX.cameraId);
    expect(event.occurred_at).toBe("2026-08-09T02:14:00+07:00");
    expect(event.received_at).toBe(CTX.receivedAt);
    expect(event.event_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(event.detection).toEqual({
      label: null,
      confidence: null,
      zone: null,
      plate: null,
      bbox: null,
    });
    expect(event.media.clip_status).toBe("none");
    expect(event.ai.verified).toBeNull();
    expect(event.raw).toEqual(GOOD_PAYLOAD);
  });

  it("maps fielddetection to intrusion and videoloss to camera_offline", () => {
    expect(
      normalizeHikvisionEvent({ ...GOOD_PAYLOAD, eventType: "fielddetection" }, CTX)
        .event_type,
    ).toBe("intrusion");
    expect(
      normalizeHikvisionEvent({ ...GOOD_PAYLOAD, eventType: "videoloss" }, CTX)
        .event_type,
    ).toBe("camera_offline");
  });

  it("maps ANPR to lpr and extracts the plate", () => {
    const event = normalizeHikvisionEvent(
      { ...GOOD_PAYLOAD, eventType: "ANPR", licensePlate: "1กข1234" },
      CTX,
    );
    expect(event.event_type).toBe("lpr");
    expect(event.detection.plate).toBe("1กข1234");
  });
});

describe("normalizeHikvisionEvent — bad payload", () => {
  it("falls back to received_at when dateTime is missing", () => {
    const { dateTime: _omit, ...noDate } = GOOD_PAYLOAD;
    const event = normalizeHikvisionEvent(noDate, CTX);
    expect(event.occurred_at).toBe(CTX.receivedAt);
  });

  it("falls back to received_at when dateTime is garbage", () => {
    const event = normalizeHikvisionEvent(
      { ...GOOD_PAYLOAD, dateTime: "not-a-date" },
      CTX,
    );
    expect(event.occurred_at).toBe(CTX.receivedAt);
  });

  it("keeps camera_id null when the route could not resolve one", () => {
    const event = normalizeHikvisionEvent(GOOD_PAYLOAD, {
      ...CTX,
      cameraId: null,
    });
    expect(event.camera_id).toBeNull();
  });
});

describe("normalizeHikvisionEvent — unknown event type", () => {
  it("becomes unknown and preserves the raw payload", () => {
    const payload = { ...GOOD_PAYLOAD, eventType: "somethingNew" };
    const event = normalizeHikvisionEvent(payload, CTX);
    expect(event.event_type).toBe("unknown");
    expect(event.raw).toEqual(payload);
  });
});

describe("normalizeHikvisionEvent — duplicates (idempotency key)", () => {
  it("same alarm re-posted yields the same source_raw_id", () => {
    const first = normalizeHikvisionEvent(GOOD_PAYLOAD, CTX);
    const repost = normalizeHikvisionEvent(
      { ...GOOD_PAYLOAD, activePostCount: "2" },
      CTX,
    );
    expect(first.source_raw_id).toBe(repost.source_raw_id);
    expect(first.source_raw_id).toBe(
      "linedetection:1:2026-08-09T02:14:00+07:00",
    );
    // event_id must still be unique per row attempt
    expect(first.event_id).not.toBe(repost.event_id);
  });

  it("different channel or time yields a different source_raw_id", () => {
    const a = normalizeHikvisionEvent(GOOD_PAYLOAD, CTX);
    const b = normalizeHikvisionEvent({ ...GOOD_PAYLOAD, channelID: "2" }, CTX);
    const c = normalizeHikvisionEvent(
      { ...GOOD_PAYLOAD, dateTime: "2026-08-09T02:15:00+07:00" },
      CTX,
    );
    expect(a.source_raw_id).not.toBe(b.source_raw_id);
    expect(a.source_raw_id).not.toBe(c.source_raw_id);
  });

  it("source_raw_id is null when the alarm cannot be identified", () => {
    const event = normalizeHikvisionEvent({ eventType: "linedetection" } as Record<string, unknown>, {
      ...CTX,
      cameraId: null,
    });
    expect(event.source_raw_id).toBeNull();
  });
});

describe("detectSourceType / normalizeEvent dispatch", () => {
  it("detects hikvision via test_source and via eventType shape", () => {
    expect(detectSourceType(GOOD_PAYLOAD)).toBe("hikvision_isapi");
    const { test_source: _omit, ...bare } = GOOD_PAYLOAD;
    expect(detectSourceType(bare)).toBe("hikvision_isapi");
  });

  it("unrecognizable payload becomes a manual/unknown event with raw kept", () => {
    const payload = { hello: "world" };
    expect(detectSourceType(payload)).toBeNull();
    const event = normalizeEvent(payload, CTX);
    expect(event.source_type).toBe("manual");
    expect(event.event_type).toBe("unknown");
    expect(event.raw).toEqual(payload);
    expect(event.occurred_at).toBe(CTX.receivedAt);
  });
});
