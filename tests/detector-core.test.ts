import { describe, expect, it } from "vitest";
import {
  buildDetectorHint,
  computeLetterbox,
  cropRegion,
  decideGate,
  decodeOutput,
  detectLayout,
  iou,
  nms,
  normalizeBox,
  parseDetectorMode,
  summarizeLabels,
  type ObjectDetection,
} from "@/lib/detector-core";

const det = (label: string, confidence: number, x: number, y: number, w: number, h: number): ObjectDetection => ({
  label,
  confidence,
  box: { x, y, w, h },
});

describe("parseDetectorMode", () => {
  it("defaults to off and accepts shadow/gate", () => {
    expect(parseDetectorMode(undefined)).toBe("off");
    expect(parseDetectorMode("nonsense")).toBe("off");
    expect(parseDetectorMode(" Shadow ")).toBe("shadow");
    expect(parseDetectorMode("gate")).toBe("gate");
  });
});

describe("computeLetterbox", () => {
  it("scales a 1920x1080 frame into 640x640 with bottom/right padding (YOLOX)", () => {
    const lb = computeLetterbox(1920, 1080, 640, 640, false);
    expect(lb.scale).toBeCloseTo(1 / 3);
    expect(lb.resizedW).toBe(640);
    expect(lb.resizedH).toBe(360);
    expect(lb.padX).toBe(0);
    expect(lb.padY).toBe(0);
  });
  it("centers when asked (YOLOv8)", () => {
    const lb = computeLetterbox(1920, 1080, 640, 640, true);
    expect(lb.padX).toBe(0);
    expect(lb.padY).toBe(140);
  });
});

describe("detectLayout", () => {
  it("recognises YOLOX, YOLOv8 and transposed YOLOv8", () => {
    expect(detectLayout([1, 8400, 85])).toBe("yolox");
    expect(detectLayout([1, 84, 8400])).toBe("yolov8");
    expect(detectLayout([1, 8400, 84])).toBe("yolov8t");
    expect(detectLayout([8400, 85])).toBeNull();
    expect(detectLayout([2, 84, 8400])).toBeNull();
  });
});

describe("decodeOutput — YOLOX layout", () => {
  it("decodes one person from the stride-8 grid back into original pixels", () => {
    const inputW = 640, inputH = 640;
    const anchors = 6400 + 1600 + 400; // 8400
    const data = new Float32Array(anchors * 85);
    // Put a detection at grid cell (gx=10, gy=20) on stride 8:
    // cx = (0.5 + 10) * 8 = 84, cy = (0.5 + 20) * 8 = 164, w = exp(ln 5)*8 = 40, h = 80
    const i = 20 * 80 + 10;
    const o = i * 85;
    data[o] = 0.5;
    data[o + 1] = 0.5;
    data[o + 2] = Math.log(5);
    data[o + 3] = Math.log(10);
    data[o + 4] = 0.9; // objectness
    data[o + 5] = 0.8; // person
    const lb = computeLetterbox(1920, 1080, inputW, inputH, false); // scale 1/3
    const out = decodeOutput(data, [1, anchors, 85], lb, 1920, 1080, {
      confThreshold: 0.3,
      iouThreshold: 0.5,
    });
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe("person");
    expect(out[0].confidence).toBeCloseTo(0.72);
    // (84 - 20) / (1/3) = 192 ; (164 - 40) * 3 = 372 ; 40*3=120 ; 80*3=240
    expect(out[0].box.x).toBeCloseTo(192);
    expect(out[0].box.y).toBeCloseTo(372);
    expect(out[0].box.w).toBeCloseTo(120);
    expect(out[0].box.h).toBeCloseTo(240);
  });

  it("returns nothing when the anchor count does not match the input size (wrong model)", () => {
    const lb = computeLetterbox(1920, 1080, 640, 640, false);
    const data = new Float32Array(3549 * 85).fill(0.99);
    expect(decodeOutput(data, [1, 3549, 85], lb, 1920, 1080, { confThreshold: 0.3, iouThreshold: 0.5 })).toEqual([]);
  });
});

describe("decodeOutput — YOLOv8 layout", () => {
  it("reads [1,84,N] channels-first and applies centered letterbox padding", () => {
    const anchors = 100;
    const data = new Float32Array(84 * anchors);
    const i = 7;
    data[0 * anchors + i] = 320; // cx
    data[1 * anchors + i] = 320; // cy (in a 640 input, padY=140 for 16:9)
    data[2 * anchors + i] = 60; // w
    data[3 * anchors + i] = 90; // h
    data[(4 + 2) * anchors + i] = 0.77; // car
    const lb = computeLetterbox(1920, 1080, 640, 640, true);
    const out = decodeOutput(data, [1, 84, anchors], lb, 1920, 1080, { confThreshold: 0.3, iouThreshold: 0.5 });
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe("car");
    expect(out[0].box.x).toBeCloseTo((320 - 30) * 3);
    expect(out[0].box.y).toBeCloseTo((320 - 45 - 140) * 3);
    expect(out[0].box.w).toBeCloseTo(180);
    expect(out[0].box.h).toBeCloseTo(270);
  });
});

describe("nms / iou", () => {
  it("suppresses overlapping boxes of the same class only", () => {
    const a = det("person", 0.9, 0, 0, 100, 100);
    const b = det("person", 0.8, 10, 10, 100, 100); // heavy overlap → dropped
    const c = det("dog", 0.7, 10, 10, 100, 100); // other class → kept
    const d = det("person", 0.6, 500, 500, 50, 50); // far away → kept
    expect(iou(a.box, b.box)).toBeGreaterThan(0.5);
    const kept = nms([d, b, c, a], 0.5);
    expect(kept.map((k) => k.label + k.confidence)).toEqual(["person0.9", "dog0.7", "person0.6"]);
  });
});

describe("decideGate", () => {
  const person = [det("person", 0.8, 10, 10, 50, 100)];
  const onlyChair = [det("chair", 0.9, 10, 10, 50, 100)];

  it("never skips when the detector is off or unavailable", () => {
    expect(decideGate({ mode: "off", eventType: "unknown", detections: [] }).action).toBe("analyze");
    const g = decideGate({ mode: "gate", eventType: "unknown", detections: null });
    expect(g.action).toBe("analyze");
    expect(g.wouldSkip).toBe(false);
  });

  it("skips motion-type events with nothing relevant only in gate mode", () => {
    const shadow = decideGate({ mode: "shadow", eventType: "unknown", detections: onlyChair });
    expect(shadow.action).toBe("analyze");
    expect(shadow.wouldSkip).toBe(true);
    const gate = decideGate({ mode: "gate", eventType: "intrusion", detections: [] });
    expect(gate.action).toBe("skip");
    expect(gate.wouldSkip).toBe(true);
  });

  it("analyzes when a person/vehicle/animal is present", () => {
    const g = decideGate({ mode: "gate", eventType: "person_detected", detections: person });
    expect(g.action).toBe("analyze");
    expect(g.relevant).toHaveLength(1);
    expect(g.reason).toContain("person×1");
  });

  it("always analyzes patrol and non-motion event types even with an empty frame", () => {
    expect(decideGate({ mode: "gate", eventType: "unknown", rawEventType: "patrol", detections: [] }).action).toBe("analyze");
    expect(decideGate({ mode: "gate", eventType: "camera_offline", detections: [] }).action).toBe("analyze");
    expect(decideGate({ mode: "gate", eventType: "lpr", detections: [] }).action).toBe("analyze");
  });
});

describe("hints, crops, summaries", () => {
  it("summarizes labels with counts", () => {
    expect(summarizeLabels([det("person", 0.9, 0, 0, 1, 1), det("person", 0.5, 0, 0, 1, 1), det("car", 0.6, 0, 0, 1, 1)])).toBe(
      "person×2, car×1",
    );
    expect(summarizeLabels([])).toBe("nothing");
  });

  it("builds a hedged Thai hint", () => {
    const hint = buildDetectorHint([det("person", 0.87, 0, 0, 1, 1), det("chair", 0.99, 0, 0, 1, 1)]);
    expect(hint).toContain("คน 1");
    expect(hint).not.toContain("chair");
    expect(hint).toContain("อาจผิดได้");
    expect(buildDetectorHint([])).toContain("ไม่พบคน/รถ");
  });

  it("crops around relevant boxes, grows to a useful size and clamps to the frame", () => {
    const box = cropRegion([det("person", 0.9, 1800, 900, 40, 80)], 1920, 1080);
    expect(box).not.toBeNull();
    expect(box!.w).toBeGreaterThanOrEqual(300);
    expect(box!.x + box!.w).toBeLessThanOrEqual(1920);
    expect(box!.y + box!.h).toBeLessThanOrEqual(1080);
  });

  it("returns null when nothing relevant or the region already covers most of the frame", () => {
    expect(cropRegion([det("chair", 0.9, 0, 0, 10, 10)], 1920, 1080)).toBeNull();
    expect(cropRegion([det("truck", 0.9, 0, 0, 1900, 1000)], 1920, 1080)).toBeNull();
  });

  it("normalizes boxes to 0-1", () => {
    expect(normalizeBox({ x: 192, y: 540, w: 960, h: 270 }, 1920, 1080)).toEqual([0.1, 0.5, 0.5, 0.25]);
  });
});

describe("buildDetectorHint — low confidence is stated, not hidden", () => {
  it("flags a weak person reading as possibly an animal or shadow", () => {
    const weak = buildDetectorHint([det("person", 0.43, 0, 0, 20, 40)]);
    expect(weak).toContain("ความมั่นใจต่ำ");
    const strong = buildDetectorHint([det("person", 0.82, 0, 0, 20, 40)]);
    expect(strong).not.toContain("ความมั่นใจต่ำ");
  });
});
