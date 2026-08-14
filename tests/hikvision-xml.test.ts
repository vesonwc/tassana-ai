import { describe, expect, it } from "vitest";
import {
  looksLikeHikvisionXml,
  normalizeHikvisionEvent,
  parseHikvisionXml,
} from "@/lib/normalizers/hikvision";
import { detectSourceType } from "@/lib/normalize";

// Shape per Hikvision ISAPI docs — will be refined against real firmware
// payloads captured on site (which land in events.raw regardless).
const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<EventNotificationAlert version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
  <ipAddress>192.168.1.64</ipAddress>
  <macAddress>a4:14:37:xx:xx:xx</macAddress>
  <channelID>1</channelID>
  <dateTime>2026-08-13T22:14:00+07:00</dateTime>
  <activePostCount>1</activePostCount>
  <eventType>linedetection</eventType>
  <eventState>active</eventState>
  <eventDescription>linedetection alarm</eventDescription>
  <channelName>Front Gate</channelName>
</EventNotificationAlert>`;

const CTX = {
  siteId: "site-1",
  cameraId: "cam-1",
  receivedAt: "2026-08-13T22:14:05+07:00",
};

describe("Hikvision XML ingestion", () => {
  it("recognizes EventNotificationAlert XML", () => {
    expect(looksLikeHikvisionXml(SAMPLE_XML)).toBe(true);
    expect(looksLikeHikvisionXml('{"eventType":"x"}')).toBe(false);
  });

  it("extracts the fields the normalizer needs", () => {
    const payload = parseHikvisionXml(SAMPLE_XML);
    expect(payload.eventType).toBe("linedetection");
    expect(payload.channelID).toBe("1");
    expect(payload.dateTime).toBe("2026-08-13T22:14:00+07:00");
    expect(payload.eventDescription).toBe("linedetection alarm");
    expect(payload._raw_xml).toContain("EventNotificationAlert");
  });

  it("parsed XML flows through the existing normalizer end-to-end", () => {
    const payload = parseHikvisionXml(SAMPLE_XML);
    expect(detectSourceType(payload)).toBe("hikvision_isapi");
    const event = normalizeHikvisionEvent(payload, CTX);
    expect(event.event_type).toBe("line_crossing");
    expect(event.source_raw_id).toBe("linedetection:1:2026-08-13T22:14:00+07:00");
    expect(event.occurred_at).toBe("2026-08-13T22:14:00+07:00");
    expect((event.raw._raw_xml as string)).toContain("linedetection");
  });

  it("unknown XML event types degrade to unknown, never rejected", () => {
    const weird = SAMPLE_XML.replace(/linedetection/g, "futureThing");
    const event = normalizeHikvisionEvent(parseHikvisionXml(weird), CTX);
    expect(event.event_type).toBe("unknown");
  });
});
