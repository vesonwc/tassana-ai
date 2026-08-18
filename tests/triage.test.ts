import { describe, expect, it } from "vitest";
import {
  BASE_SCORE,
  MAX_SCORE,
  sceneSignature,
  triageScore,
  type TriageInput,
} from "@/lib/triage";
import type { ObjectDetection } from "@/lib/detector-core";

const det = (label: string, confidence = 0.8): ObjectDetection => ({
  label,
  confidence,
  box: { x: 0, y: 0, w: 10, h: 20 },
});

const base: TriageInput = {
  eventType: "person_detected",
  detections: [],
  nowHourBangkok: 12,
};

describe("triageScore — ADR-016 nurse rules", () => {
  it("never scores below the floor, even when the detector sees nothing", () => {
    const r = triageScore(base);
    expect(r.score).toBe(BASE_SCORE);
    expect(r.score).toBeGreaterThan(0);
  });

  it("scores an unavailable detector HIGHER than an empty frame (blindness is not safety)", () => {
    const blind = triageScore({ ...base, detections: null });
    const empty = triageScore(base);
    expect(blind.score).toBeGreaterThan(empty.score);
    expect(blind.reasons.join()).toContain("ใช้งานไม่ได้");
  });

  it("adds for people and adds more at night", () => {
    const day = triageScore({ ...base, detections: [det("person")] });
    const night = triageScore({ ...base, detections: [det("person")], nowHourBangkok: 3 });
    expect(day.score).toBeGreaterThan(BASE_SCORE);
    expect(night.score).toBeGreaterThan(day.score);
  });

  it("ranks a person in a should-be-empty camera above a person in an office camera", () => {
    const office = triageScore({
      ...base,
      detections: [det("person")],
      nowHourBangkok: 3,
      profileName: "จุดทำงาน",
    });
    const fence = triageScore({
      ...base,
      detections: [det("person")],
      nowHourBangkok: 3,
      profileName: "รั้ว/แนวเขต",
    });
    expect(fence.score).toBeGreaterThan(office.score);
  });

  it("never lets any signal subtract — more facts can only raise the score", () => {
    const plain = triageScore({ ...base, detections: [det("person")] });
    const loaded = triageScore({
      ...base,
      detections: [det("person"), det("person"), det("person"), det("car"), det("dog")],
      nowHourBangkok: 2,
      inStrictHours: true,
      eventType: "intrusion",
      profileName: "ลานจอด",
      minutesSinceCameraLastAnalyzed: 45,
    });
    expect(loaded.score).toBeGreaterThanOrEqual(plain.score);
    expect(loaded.score).toBe(MAX_SCORE); // saturates rather than overflowing
  });

  it("sends patrol frames and camera status changes straight to the front", () => {
    expect(triageScore({ ...base, rawEventType: "patrol" }).score).toBe(MAX_SCORE);
    expect(triageScore({ ...base, eventType: "camera_offline" }).score).toBe(MAX_SCORE);
  });

  it("boosts events from a camera that has waited, so quiet cameras cannot starve", () => {
    const fresh = triageScore({ ...base, detections: [det("person")] });
    const waited = triageScore({ ...base, detections: [det("person")], minutesSinceCameraLastAnalyzed: 90 });
    expect(waited.score).toBeGreaterThan(fresh.score);
    // aging is capped so waiting alone never outranks a real signal
    const forever = triageScore({ ...base, detections: [det("person")], minutesSinceCameraLastAnalyzed: 10_000 });
    expect(forever.score - fresh.score).toBeLessThanOrEqual(20);
  });

  it("adds for a scene this camera rarely produces, and only with enough history", () => {
    const recent = ["person:1", "person:1", "person:2-3", "person:1", "person:2-3"];
    const usual = triageScore({ ...base, detections: [det("person")], recentSignatures: recent });
    const rare = triageScore({
      ...base,
      detections: [det("person"), det("person"), det("person"), det("person"), det("person"), det("person"), det("person"), det("person")],
      recentSignatures: recent,
    });
    expect(rare.score).toBeGreaterThan(usual.score);
    // with too little history we must not claim anything is rare
    const noHistory = triageScore({ ...base, detections: [det("person")], recentSignatures: ["person:1"] });
    expect(noHistory.reasons.join()).not.toContain("ต่างจาก");
  });
});

describe("sceneSignature", () => {
  it("buckets counts and ignores furniture", () => {
    expect(sceneSignature([det("person"), det("person"), det("chair"), det("tv")])).toBe("person:2-3");
    expect(sceneSignature([det("chair")])).toBe("empty");
    expect(sceneSignature([det("car"), det("person")])).toBe("car:1,person:1");
  });
});
