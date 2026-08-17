import { describe, expect, it } from "vitest";
import { normalizeHikvisionEvent } from "@/lib/normalizers/hikvision";

const CTX = {
  siteId: "s",
  cameraId: "c",
  receivedAt: "2026-08-17T12:04:58+07:00",
};

describe("device clock skew guard", () => {
  it("keeps device time when within 5 minutes of receipt", () => {
    const ev = normalizeHikvisionEvent(
      { eventType: "VMD", channelID: "7", dateTime: "2026-08-17T12:03:10+07:00" },
      CTX,
    );
    expect(ev.occurred_at).toBe("2026-08-17T12:03:10+07:00");
    expect(ev.raw._device_clock_skew_sec).toBeUndefined();
  });

  it("falls back to receive time when the NVR clock is 24 minutes slow", () => {
    const ev = normalizeHikvisionEvent(
      { eventType: "VMD", channelID: "7", dateTime: "2026-08-17T11:40:54+07:00" },
      CTX,
    );
    expect(ev.occurred_at).toBe(CTX.receivedAt);
    expect(ev.raw._device_clock_skew_sec).toBe(-1444);
  });
});
