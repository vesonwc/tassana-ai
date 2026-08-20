// Content-based "has anything actually happened?" for the on-site bridge
// (ADR-017). Replaces a blind time cooldown: instead of ignoring a channel for
// minutes at a time, look at every frame cheaply and forward the ones where the
// scene really moved.
//
// Deliberately conservative: anything it cannot explain counts as a change, and
// a periodic forced send covers what an object detector cannot see at all
// (smoke, a covered lens, a person who collapsed without moving position).

import { GATE_LABELS, iou, type Box, type ObjectDetection } from "./detector-core";

export interface SceneChangeOptions {
  // Below this IoU two boxes of the same class are treated as different places.
  moveIou?: number;
  // Ignore detections weaker than this when comparing (they flicker).
  minConfidence?: number;
}

export interface SceneChangeResult {
  changed: boolean;
  // Something ARRIVED that was not there before (a new class, or more of one).
  // Movement of things already present, or something leaving, is a change but
  // not an arrival — and only arrivals are worth jumping the queue for.
  significant: boolean;
  reason: string;
}

function relevant(dets: ObjectDetection[], minConfidence: number): ObjectDetection[] {
  return dets.filter((d) => GATE_LABELS.has(d.label) && d.confidence >= minConfidence);
}

function countByLabel(dets: ObjectDetection[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const d of dets) m.set(d.label, (m.get(d.label) ?? 0) + 1);
  return m;
}

// Greedy match: every object in `next` must sit roughly where an object of the
// same class sat in `prev`, and each previous box is consumed once.
function everyObjectStayedPut(
  prev: ObjectDetection[],
  next: ObjectDetection[],
  moveIou: number,
): boolean {
  const pool: (Box | null)[] = prev.map((p) => p.box);
  const labels = prev.map((p) => p.label);
  for (const d of next) {
    let bestIdx = -1;
    let bestIou = moveIou;
    for (let i = 0; i < pool.length; i++) {
      const box = pool[i];
      if (!box || labels[i] !== d.label) continue;
      const score = iou(box, d.box);
      if (score >= bestIou) {
        bestIou = score;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) return false;
    pool[bestIdx] = null;
  }
  return true;
}

export function sceneChanged(
  prev: ObjectDetection[] | null,
  next: ObjectDetection[],
  opts: SceneChangeOptions = {},
): SceneChangeResult {
  const moveIou = opts.moveIou ?? 0.6;
  const minConfidence = opts.minConfidence ?? 0.3;
  // No baseline yet — the first frame after start-up is always worth sending.
  if (prev === null) return { changed: true, significant: true, reason: "ยังไม่มีภาพอ้างอิง" };

  const a = relevant(prev, minConfidence);
  const b = relevant(next, minConfidence);
  if (a.length === 0 && b.length === 0) {
    return { changed: false, significant: false, reason: "ไม่มีคน/รถ ทั้งภาพก่อนและภาพนี้" };
  }
  const ca = countByLabel(a);
  const cb = countByLabel(b);
  // Arrivals first — these are the ones allowed to jump the queue.
  for (const [label, n] of cb) {
    const before = ca.get(label) ?? 0;
    if (n > before) {
      return {
        changed: true,
        significant: true,
        reason: before === 0 ? `${label} ปรากฏขึ้นใหม่` : `${label} เพิ่มจาก ${before} เป็น ${n}`,
      };
    }
  }
  for (const [label, n] of ca) {
    const now = cb.get(label) ?? 0;
    if (now < n) {
      return { changed: true, significant: false, reason: `${label} ลดจาก ${n} เหลือ ${now}` };
    }
  }
  if (!everyObjectStayedPut(a, b, moveIou)) {
    return { changed: true, significant: false, reason: "มีวัตถุเปลี่ยนตำแหน่ง" };
  }
  return { changed: false, significant: false, reason: "จำนวนและตำแหน่งเหมือนเดิม" };
}
