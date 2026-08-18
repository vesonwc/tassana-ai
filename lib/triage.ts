// Triage scoring (ADR-016): the detector acts as a nurse, not a doctor —
// it sets the ORDER in which events reach the VLM, never whether they may.
// Pure functions only; the worker feeds it facts, this file has no I/O.

import { GATE_LABELS, type ObjectDetection } from "./detector-core";

// Every event starts here. The detector is blind to smoke, fire, a covered
// lens or a collapsed person, so "saw nothing" can never mean "score zero".
export const BASE_SCORE = 25;
export const MAX_SCORE = 100;

// Weights are data, not scattered magic numbers — tuned by simulation
// (worker/tools/triage-sim.ts) against real events.
export interface TriageWeights {
  person: number;
  crowd: number; // 3+ people
  vehicle: number;
  animal: number;
  night: number; // outside busy hours
  strictHours: number; // inside the site's own "watch closely" window
  shouldBeEmpty: number; // camera whose job implies no people belong here
  seriousType: number; // NVR said intrusion / line crossing / loitering
  rareScene: number; // this composition is unusual for this camera
  detectorBlind: number; // detector unavailable → we are less informed, not safer
  agingPer10Min: number;
  agingCap: number;
}

export const DEFAULT_WEIGHTS: TriageWeights = {
  person: 30,
  crowd: 5,
  vehicle: 10,
  animal: 5,
  night: 20,
  strictHours: 15,
  shouldBeEmpty: 15,
  seriousType: 25,
  rareScene: 15,
  detectorBlind: 10,
  agingPer10Min: 3,
  agingCap: 20,
};

// Event types whose meaning does not depend on what the detector can see —
// these always go straight to the front (ADR-011 layer 1 / ADR-015 §4).
export const ALWAYS_URGENT_TYPES = new Set(["camera_offline", "camera_online"]);

// Camera profiles where a human being present is itself the story.
const EMPTY_BY_DEFAULT = /รั้ว|แนวเขต|ลานจอด|ทางหนีไฟ|หลังเลิกงาน|afterhours|perimeter|fence|parking/i;

const SERIOUS_TYPES = new Set(["intrusion", "line_crossing", "loitering"]);

export interface TriageInput {
  eventType: string;
  rawEventType?: string | null;
  // null = the detector could not run (fail-open path) — scores HIGHER, not lower.
  detections: ObjectDetection[] | null;
  nowHourBangkok: number; // 0-23, hour the event occurred
  busyStartHour?: number; // default 07
  busyEndHour?: number; // default 18
  inStrictHours?: boolean;
  profileName?: string | null;
  // Scene signatures this camera produced recently (see sceneSignature).
  recentSignatures?: string[];
  minutesSinceCameraLastAnalyzed?: number;
  weights?: Partial<TriageWeights>;
}

export interface TriageResult {
  score: number;
  reasons: string[]; // Thai, shown in the dashboard so a human can audit the queue
}

// Coarse description of a frame: which interesting classes, in count buckets.
// Deliberately blunt — it is used to spot "this looks unusual for this camera",
// never to claim two frames are the same situation (ADR-015 lesson).
export function sceneSignature(dets: ObjectDetection[]): string {
  const counts = new Map<string, number>();
  for (const d of dets) {
    if (!GATE_LABELS.has(d.label)) continue;
    counts.set(d.label, (counts.get(d.label) ?? 0) + 1);
  }
  const bucket = (n: number) => (n <= 1 ? "1" : n <= 3 ? "2-3" : n <= 6 ? "4-6" : "7+");
  return (
    [...counts.entries()]
      .sort()
      .map(([label, n]) => `${label}:${bucket(n)}`)
      .join(",") || "empty"
  );
}

export function triageScore(input: TriageInput): TriageResult {
  const w = { ...DEFAULT_WEIGHTS, ...input.weights };
  const reasons: string[] = [];
  let score = BASE_SCORE;

  const isPatrol = /patrol/i.test(input.rawEventType ?? "");
  if (isPatrol || ALWAYS_URGENT_TYPES.has(input.eventType)) {
    return {
      score: MAX_SCORE,
      reasons: [isPatrol ? "ภาพตรวจเวรตามรอบ" : "สถานะกล้องเปลี่ยน"],
    };
  }

  const busyStart = input.busyStartHour ?? 7;
  const busyEnd = input.busyEndHour ?? 18;
  const isNight = input.nowHourBangkok < busyStart || input.nowHourBangkok >= busyEnd;
  const shouldBeEmpty = EMPTY_BY_DEFAULT.test(input.profileName ?? "");

  if (input.detections === null) {
    score += w.detectorBlind;
    reasons.push("ตัวตรวจจับใช้งานไม่ได้ (ไม่รู้ว่ามีอะไร)");
  } else {
    const relevant = input.detections.filter((d) => GATE_LABELS.has(d.label));
    const people = relevant.filter((d) => d.label === "person");
    const vehicles = relevant.filter((d) =>
      ["car", "motorcycle", "bus", "truck", "bicycle"].includes(d.label),
    );
    const animals = relevant.filter((d) => ["dog", "cat", "horse", "cow", "sheep"].includes(d.label));
    if (people.length > 0) {
      score += w.person;
      reasons.push(`พบคน ${people.length} คน`);
      if (people.length >= 3) {
        score += w.crowd;
        reasons.push("คนหลายคน");
      }
      if (shouldBeEmpty) {
        score += w.shouldBeEmpty;
        reasons.push("กล้องนี้ตามหน้าที่ควรไม่มีคน");
      }
    }
    if (vehicles.length > 0) {
      score += w.vehicle;
      reasons.push(`พบยานพาหนะ ${vehicles.length}`);
    }
    if (animals.length > 0) {
      score += w.animal;
      reasons.push("พบสัตว์");
    }
    // Unusual composition for this camera — computed against what this camera
    // has actually been producing, not against a global idea of "normal".
    const recent = input.recentSignatures ?? [];
    if (recent.length >= 5) {
      const sig = sceneSignature(input.detections);
      if (!recent.includes(sig)) {
        score += w.rareScene;
        reasons.push("ฉากต่างจากที่กล้องนี้เห็นเป็นประจำ");
      }
    }
  }

  if (isNight) {
    score += w.night;
    reasons.push("นอกเวลาทำการ");
  }
  if (input.inStrictHours) {
    score += w.strictHours;
    reasons.push("อยู่ในช่วงเฝ้าระวังเข้มข้น");
  }
  if (SERIOUS_TYPES.has(input.eventType)) {
    score += w.seriousType;
    reasons.push("ประเภทเหตุการณ์รุนแรง");
  }

  const waited = input.minutesSinceCameraLastAnalyzed ?? 0;
  if (waited > 0) {
    const boost = Math.min(w.agingCap, Math.floor(waited / 10) * w.agingPer10Min);
    if (boost > 0) {
      score += boost;
      reasons.push(`กล้องนี้ไม่ได้ถูกตรวจมา ${Math.round(waited)} นาที`);
    }
  }

  return { score: Math.min(MAX_SCORE, score), reasons };
}
