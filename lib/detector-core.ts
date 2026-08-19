// Object-detector core (ADR-015): pure math + gate policy, no native deps.
// The ONNX runtime lives in worker/detector.ts; everything here is unit-testable.

export type DetectorMode = "off" | "shadow" | "gate";

export function parseDetectorMode(raw: string | undefined): DetectorMode {
  const v = (raw ?? "off").trim().toLowerCase();
  return v === "shadow" || v === "gate" ? v : "off";
}

// Pixel box in the *original* image.
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ObjectDetection {
  label: string;
  confidence: number;
  box: Box;
}

// COCO-80 class order (shared by YOLOX and YOLOv8 pretrained weights).
export const COCO_LABELS = [
  "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat",
  "traffic light", "fire hydrant", "stop sign", "parking meter", "bench", "bird", "cat",
  "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra", "giraffe", "backpack",
  "umbrella", "handbag", "tie", "suitcase", "frisbee", "skis", "snowboard", "sports ball",
  "kite", "baseball bat", "baseball glove", "skateboard", "surfboard", "tennis racket",
  "bottle", "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple",
  "sandwich", "orange", "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair",
  "couch", "potted plant", "bed", "dining table", "toilet", "tv", "laptop", "mouse",
  "remote", "keyboard", "cell phone", "microwave", "oven", "toaster", "sink",
  "refrigerator", "book", "clock", "vase", "scissors", "teddy bear", "hair drier",
  "toothbrush",
];

// Thai names for the labels that matter in security footage.
const LABEL_TH: Record<string, string> = {
  person: "คน",
  bicycle: "จักรยาน",
  car: "รถยนต์",
  motorcycle: "มอเตอร์ไซค์",
  bus: "รถบัส",
  truck: "รถบรรทุก/กระบะ",
  train: "รถไฟ",
  boat: "เรือ",
  dog: "สุนัข",
  cat: "แมว",
  horse: "ม้า",
  cow: "วัว",
  sheep: "แกะ",
  elephant: "ช้าง",
  bear: "หมี",
  bird: "นก",
};

// ---------------------------------------------------------------- letterbox

export interface Letterbox {
  scale: number; // src → model input
  padX: number; // left padding in model-input pixels
  padY: number; // top padding
  inputW: number;
  inputH: number;
  resizedW: number;
  resizedH: number;
}

// YOLOX's reference preprocessing pads bottom/right (center=false); YOLOv8's
// pads on both sides (center=true). Both keep aspect ratio.
export function computeLetterbox(
  srcW: number,
  srcH: number,
  inputW: number,
  inputH: number,
  center: boolean,
): Letterbox {
  const scale = Math.min(inputW / srcW, inputH / srcH);
  const resizedW = Math.max(1, Math.round(srcW * scale));
  const resizedH = Math.max(1, Math.round(srcH * scale));
  return {
    scale,
    padX: center ? Math.floor((inputW - resizedW) / 2) : 0,
    padY: center ? Math.floor((inputH - resizedH) / 2) : 0,
    inputW,
    inputH,
    resizedW,
    resizedH,
  };
}

// ---------------------------------------------------------------- decode

export type OutputLayout = "yolox" | "yolov8" | "yolov8t";

// Sniff the tensor layout from its dims. Returns null when unrecognised so the
// caller can fail open instead of decoding garbage.
export function detectLayout(dims: readonly number[]): OutputLayout | null {
  if (dims.length !== 3 || dims[0] !== 1) return null;
  const [, a, b] = dims;
  // YOLOX: [1, anchors, 4 + 1 obj + classes]
  if (b >= 6 && b < a && b === 85) return "yolox";
  // YOLOv8/11: [1, 4 + classes, anchors]
  if (a >= 5 && a < b) return "yolov8";
  // Some exports transpose to [1, anchors, 4 + classes]
  if (b >= 5 && b < a) return "yolov8t";
  return null;
}

export interface DecodeOptions {
  confThreshold: number;
  iouThreshold: number;
  labels?: readonly string[];
  strides?: readonly number[]; // YOLOX only
  maxDetections?: number;
  layout?: OutputLayout; // override the dims sniff (env YOLO_LAYOUT)
}

const YOLOX_STRIDES = [8, 16, 32] as const;

function toOriginal(
  cx: number,
  cy: number,
  w: number,
  h: number,
  lb: Letterbox,
  srcW: number,
  srcH: number,
): Box {
  let x1 = (cx - w / 2 - lb.padX) / lb.scale;
  let y1 = (cy - h / 2 - lb.padY) / lb.scale;
  let x2 = (cx + w / 2 - lb.padX) / lb.scale;
  let y2 = (cy + h / 2 - lb.padY) / lb.scale;
  x1 = Math.max(0, Math.min(srcW, x1));
  x2 = Math.max(0, Math.min(srcW, x2));
  y1 = Math.max(0, Math.min(srcH, y1));
  y2 = Math.max(0, Math.min(srcH, y2));
  return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) };
}

export function decodeOutput(
  data: ArrayLike<number>,
  dims: readonly number[],
  lb: Letterbox,
  srcW: number,
  srcH: number,
  opts: DecodeOptions,
): ObjectDetection[] {
  const layout = opts.layout ?? detectLayout(dims);
  if (!layout) return [];
  const labels = opts.labels ?? COCO_LABELS;
  const raw: ObjectDetection[] = [];

  if (layout === "yolox") {
    const anchors = dims[1];
    const stride0 = dims[2];
    const nc = stride0 - 5;
    const strides = opts.strides ?? YOLOX_STRIDES;
    // Grid order: for each stride, row-major cells. Sanity-check the count so
    // a model exported at another input size cannot silently mis-decode.
    let expected = 0;
    for (const s of strides) expected += Math.floor(lb.inputH / s) * Math.floor(lb.inputW / s);
    if (expected !== anchors) return [];
    let i = 0;
    for (const s of strides) {
      const hs = Math.floor(lb.inputH / s);
      const ws = Math.floor(lb.inputW / s);
      for (let gy = 0; gy < hs; gy++) {
        for (let gx = 0; gx < ws; gx++, i++) {
          const o = i * stride0;
          const obj = data[o + 4];
          if (obj < opts.confThreshold) continue;
          let best = 0;
          let bestK = -1;
          for (let k = 0; k < nc; k++) {
            const v = data[o + 5 + k];
            if (v > best) {
              best = v;
              bestK = k;
            }
          }
          const score = obj * best;
          if (score < opts.confThreshold || bestK < 0) continue;
          const cx = (data[o] + gx) * s;
          const cy = (data[o + 1] + gy) * s;
          const w = Math.exp(data[o + 2]) * s;
          const h = Math.exp(data[o + 3]) * s;
          raw.push({
            label: labels[bestK] ?? `class_${bestK}`,
            confidence: score,
            box: toOriginal(cx, cy, w, h, lb, srcW, srcH),
          });
        }
      }
    }
  } else {
    const channels = layout === "yolov8" ? dims[1] : dims[2];
    const anchors = layout === "yolov8" ? dims[2] : dims[1];
    const nc = channels - 4;
    const at =
      layout === "yolov8"
        ? (c: number, i: number) => data[c * anchors + i]
        : (c: number, i: number) => data[i * channels + c];
    for (let i = 0; i < anchors; i++) {
      let best = 0;
      let bestK = -1;
      for (let k = 0; k < nc; k++) {
        const v = at(4 + k, i);
        if (v > best) {
          best = v;
          bestK = k;
        }
      }
      if (best < opts.confThreshold || bestK < 0) continue;
      raw.push({
        label: labels[bestK] ?? `class_${bestK}`,
        confidence: best,
        box: toOriginal(at(0, i), at(1, i), at(2, i), at(3, i), lb, srcW, srcH),
      });
    }
  }

  return nms(raw, opts.iouThreshold).slice(0, opts.maxDetections ?? 50);
}

// ---------------------------------------------------------------- NMS

export function iou(a: Box, b: Box): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union <= 0 ? 0 : inter / union;
}

// Class-aware greedy NMS; result sorted by confidence desc.
export function nms(dets: ObjectDetection[], iouThreshold: number): ObjectDetection[] {
  const sorted = [...dets].sort((a, b) => b.confidence - a.confidence);
  const kept: ObjectDetection[] = [];
  for (const d of sorted) {
    if (d.box.w <= 0 || d.box.h <= 0) continue;
    const overlaps = kept.some(
      (k) => k.label === d.label && iou(k.box, d.box) > iouThreshold,
    );
    if (!overlaps) kept.push(d);
  }
  return kept;
}

// ---------------------------------------------------------------- gate policy

// Anything a security guard would want a second look at. Static COCO classes
// (chair, potted plant, tv…) are deliberately absent — they are always in frame.
export const GATE_LABELS = new Set([
  "person", "bicycle", "car", "motorcycle", "bus", "truck", "train", "boat",
  "dog", "cat", "horse", "cow", "sheep", "elephant", "bear",
]);

// Event types whose whole meaning is "someone/something moved". Everything else
// (patrol, camera_offline/online, lpr…) always reaches the VLM.
export const GATED_EVENT_TYPES = new Set([
  "person_detected", "vehicle_detected", "line_crossing", "intrusion", "loitering", "unknown",
]);

export type GateAction = "analyze" | "skip";

export interface GateDecision {
  action: GateAction;
  // True whenever the detector saw nothing relevant — in shadow mode the
  // action stays "analyze" but this records what gate mode would have done.
  wouldSkip: boolean;
  reason: string;
  relevant: ObjectDetection[];
}

export function decideGate(input: {
  mode: DetectorMode;
  eventType: string;
  rawEventType?: string | null;
  detections: ObjectDetection[] | null; // null = detector unavailable/errored
}): GateDecision {
  const none: ObjectDetection[] = [];
  if (input.mode === "off") {
    return { action: "analyze", wouldSkip: false, reason: "detector off", relevant: none };
  }
  if (input.detections === null) {
    // Fail-open (ADR-005/015): no detector verdict → behave as if it were absent.
    return { action: "analyze", wouldSkip: false, reason: "detector unavailable", relevant: none };
  }
  if (/patrol/i.test(input.rawEventType ?? "")) {
    return { action: "analyze", wouldSkip: false, reason: "patrol always analyzed", relevant: none };
  }
  if (!GATED_EVENT_TYPES.has(input.eventType)) {
    return {
      action: "analyze",
      wouldSkip: false,
      reason: `event type ${input.eventType} always analyzed`,
      relevant: none,
    };
  }
  const relevant = input.detections.filter((d) => GATE_LABELS.has(d.label));
  if (relevant.length > 0) {
    return {
      action: "analyze",
      wouldSkip: false,
      reason: `found ${summarizeLabels(relevant)}`,
      relevant,
    };
  }
  return {
    action: input.mode === "gate" ? "skip" : "analyze",
    wouldSkip: true,
    reason: "nothing relevant detected",
    relevant,
  };
}

// "person×2, car×1" — for logs and ai.detector.
export function summarizeLabels(dets: ObjectDetection[]): string {
  const counts = new Map<string, number>();
  for (const d of dets) counts.set(d.label, (counts.get(d.label) ?? 0) + 1);
  return [...counts.entries()].map(([l, n]) => `${l}×${n}`).join(", ") || "nothing";
}

// Thai hint for the VLM prompt. Deliberately hedged so a wrong detector verdict
// does not anchor the VLM (ADR-015 §6).
export function buildDetectorHint(dets: ObjectDetection[]): string {
  const relevant = dets.filter((d) => GATE_LABELS.has(d.label));
  if (relevant.length === 0) {
    return "ตัวตรวจจับวัตถุเบื้องต้นไม่พบคน/รถ/สัตว์ในภาพ (อาจพลาดได้ ให้เชื่อสิ่งที่เห็นในภาพเป็นหลัก)";
  }
  const groups = new Map<string, number[]>();
  for (const d of relevant) {
    const arr = groups.get(d.label) ?? [];
    arr.push(d.confidence);
    groups.set(d.label, arr);
  }
  const parts = [...groups.entries()].map(([label, confs]) => {
    const th = LABEL_TH[label] ?? label;
    const shown = confs
      .slice(0, 4)
      .map((c) => c.toFixed(2))
      .join(", ");
    // A weak reading is worth saying out loud: at night the detector calls a
    // dog or a chair "person" at exactly these confidences.
    const weak = Math.max(...confs) < 0.5 ? " — ความมั่นใจต่ำ อาจเป็นสัตว์ เงา หรือวัตถุอื่น" : "";
    return `${th} ${confs.length} (ความมั่นใจ ${shown}${confs.length > 4 ? ", …" : ""})${weak}`;
  });
  return `ตัวตรวจจับวัตถุเบื้องต้นพบ: ${parts.join(", ")} — ตัวเลขนี้เป็นเพียงคำใบ้ อาจผิดได้ ให้เชื่อสิ่งที่เห็นในภาพเป็นหลัก และภาพที่ 2 (ถ้ามี) คือส่วนขยายบริเวณที่พบ`;
}

// ---------------------------------------------------------------- crop region

export interface CropOptions {
  marginPct?: number; // expand union box by this fraction of its size (each side)
  minSize?: number; // grow to at least this many px on each axis when possible
  maxAreaFrac?: number; // skip cropping when the region already covers most of the frame
}

// Union of the relevant boxes, expanded, clamped. null = crop would not help.
export function cropRegion(
  dets: ObjectDetection[],
  srcW: number,
  srcH: number,
  opts: CropOptions = {},
): Box | null {
  const relevant = dets.filter((d) => GATE_LABELS.has(d.label));
  if (relevant.length === 0) return null;
  const margin = opts.marginPct ?? 0.35;
  const minSize = opts.minSize ?? 320;
  const maxAreaFrac = opts.maxAreaFrac ?? 0.6;

  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const d of relevant) {
    x1 = Math.min(x1, d.box.x);
    y1 = Math.min(y1, d.box.y);
    x2 = Math.max(x2, d.box.x + d.box.w);
    y2 = Math.max(y2, d.box.y + d.box.h);
  }
  let w = x2 - x1;
  let h = y2 - y1;
  // Expand by margin, then to the minimum useful size, keeping the centre.
  const cx = x1 + w / 2;
  const cy = y1 + h / 2;
  w = Math.max(w * (1 + margin * 2), Math.min(minSize, srcW));
  h = Math.max(h * (1 + margin * 2), Math.min(minSize, srcH));
  w = Math.min(w, srcW);
  h = Math.min(h, srcH);
  // Slide the window back inside the frame (objects near an edge keep a
  // full-size crop) and only then clamp.
  x1 = Math.round(cx - w / 2);
  y1 = Math.round(cy - h / 2);
  if (x1 < 0) x1 = 0;
  if (y1 < 0) y1 = 0;
  if (x1 + w > srcW) x1 = Math.round(srcW - w);
  if (y1 + h > srcH) y1 = Math.round(srcH - h);
  x2 = Math.min(srcW, Math.round(x1 + w));
  y2 = Math.min(srcH, Math.round(y1 + h));
  const box = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  if (box.w <= 0 || box.h <= 0) return null;
  if ((box.w * box.h) / (srcW * srcH) > maxAreaFrac) return null;
  return box;
}

// Normalised [x, y, w, h] in 0-1 for storage (matches docs/event-schema.md bbox).
export function normalizeBox(b: Box, srcW: number, srcH: number): [number, number, number, number] {
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return [r(b.x / srcW), r(b.y / srcH), r(b.w / srcW), r(b.h / srcH)];
}
