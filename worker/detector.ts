// Object detector runtime (ADR-015): ONNX Runtime + jimp, worker only.
// Fail-open by design — every public function resolves to null on any
// failure so the caller can carry on as if no detector existed.

import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Jimp } from "jimp";
import {
  computeLetterbox,
  cropRegion,
  decodeOutput,
  detectLayout,
  nms,
  parseDetectorMode,
  type Box,
  type DetectorMode,
  type ObjectDetection,
  type OutputLayout,
} from "../lib/detector-core";

export const DETECTOR_MODE: DetectorMode = parseDetectorMode(process.env.YOLO_MODE);
// YOLOX-tiny: Apache-2.0, official Megvii release (ADR-015 §2). Measured on
// 150 real office events: the yolox_s.onnx from the same release scores
// objectness < 0.35 on obvious people (broken export?) while tiny + tiled
// passes catch small night-time figures — see docs/roadmap.md.
const DEFAULT_MODEL_URL =
  "https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_tiny.onnx";
export const MODEL_PATH = process.env.YOLO_MODEL_PATH ?? "models/yolox_tiny.onnx";
const MODEL_URL = process.env.YOLO_MODEL_URL ?? DEFAULT_MODEL_URL;
const CONF_THRESHOLD = Number(process.env.YOLO_CONF ?? 0.3);
const IOU_THRESHOLD = Number(process.env.YOLO_IOU ?? 0.45);
export const DETECTOR_TIMEOUT_MS = Number(process.env.YOLO_TIMEOUT_MS ?? 3_000);
const LAYOUT_OVERRIDE = process.env.YOLO_LAYOUT as OutputLayout | undefined;
const THREADS = Number(process.env.YOLO_THREADS ?? 2);
// YOLOX weights from the 0.1.x era were trained with ImageNet mean/std on RGB.
const YOLOX_LEGACY = process.env.YOLOX_LEGACY === "1";
// 1 = full frame only, 4 = full frame + 2x2 overlapping tiles (small people).
const TILES = Number(process.env.YOLO_TILES ?? 4) === 4 ? 4 : 1;

// Fraction of `a` that lies inside `b`.
function containment(a: Box, b: Box): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const area = a.w * a.h;
  return area <= 0 ? 0 : inter / area;
}

export interface DetectorRun {
  detections: ObjectDetection[];
  width: number;
  height: number;
  ms: number;
  model: string;
}

type OrtModule = typeof import("onnxruntime-node");
type OrtSession = import("onnxruntime-node").InferenceSession;

interface LoadedModel {
  ort: OrtModule;
  session: OrtSession;
  inputName: string;
  outputName: string;
  inputW: number;
  inputH: number;
  layout: OutputLayout | null;
  name: string;
}

// Loading happens ONLY in the background, never inside the event pipeline:
// a stalled download or a wedged native session must never hold up the queue
// (ADR-005/015 fail-open). Events that arrive before the model is ready simply
// go straight to the VLM.
type LoadState = "idle" | "loading" | "ready" | "failed";
let loadState: LoadState = "idle";
let loaded: LoadedModel | null = null;
let nextRetryAt = 0;
let disabledReason: string | null = null;
// Cold start on Railway = download + session create. Generous, but bounded.
const MODEL_LOAD_TIMEOUT_MS = Number(process.env.YOLO_LOAD_TIMEOUT_MS ?? 180_000);
const LOAD_RETRY_MS = Number(process.env.YOLO_LOAD_RETRY_MS ?? 10 * 60_000);
// If detection keeps timing out, stop trying for this process — a slow box
// must degrade to "no detector", never to a slow pipeline.
const MAX_CONSECUTIVE_TIMEOUTS = Number(process.env.YOLO_MAX_TIMEOUTS ?? 5);
let consecutiveTimeouts = 0;
let givenUp = false;

export function modelName(): string {
  return MODEL_PATH.split(/[\\/]/).pop()?.replace(/\.onnx$/i, "") ?? "detector";
}

// Download the ONNX file once (Railway has no persistent disk between deploys,
// so this runs at every cold start — 35 MB from GitHub is a few seconds).
async function ensureModelFile(): Promise<boolean> {
  if (existsSync(MODEL_PATH) && statSync(MODEL_PATH).size > 1_000_000) return true;
  if (!MODEL_URL) {
    disabledReason = `model file ${MODEL_PATH} missing and YOLO_MODEL_URL not set`;
    return false;
  }
  console.log(`detector: downloading model → ${MODEL_PATH} from ${MODEL_URL}`);
  try {
    mkdirSync(dirname(MODEL_PATH), { recursive: true });
    const res = await fetch(MODEL_URL, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const tmp = `${MODEL_PATH}.part`;
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp));
    renameSync(tmp, MODEL_PATH);
    console.log(`detector: model ready (${(statSync(MODEL_PATH).size / 1e6).toFixed(1)} MB)`);
    return true;
  } catch (err) {
    disabledReason = `model download failed: ${(err as Error).message}`;
    return false;
  }
}

async function loadModel(): Promise<LoadedModel | null> {
  if (!(await ensureModelFile())) return null;
  let ort: OrtModule;
  try {
    ort = await import("onnxruntime-node");
  } catch (err) {
    disabledReason = `onnxruntime-node not available: ${(err as Error).message}`;
    return null;
  }
  try {
    const session = await ort.InferenceSession.create(MODEL_PATH, {
      executionProviders: ["cpu"],
      intraOpNumThreads: THREADS,
      graphOptimizationLevel: "all",
    });
    const inputName = session.inputNames[0];
    const outputName = session.outputNames[0];
    // Read the expected input size from the model; fall back to 640.
    const meta = (session as unknown as { inputMetadata?: Array<{ shape?: unknown[] }> })
      .inputMetadata?.[0];
    const shape = Array.isArray(meta?.shape) ? (meta!.shape as unknown[]) : [];
    const inputH = typeof shape[2] === "number" && shape[2] > 0 ? (shape[2] as number) : 640;
    const inputW = typeof shape[3] === "number" && shape[3] > 0 ? (shape[3] as number) : 640;
    const loaded: LoadedModel = {
      ort,
      session,
      inputName,
      outputName,
      inputW,
      inputH,
      layout: LAYOUT_OVERRIDE ?? null,
      name: modelName(),
    };
    console.log(
      `detector: loaded ${loaded.name} (${inputW}x${inputH}, input "${inputName}", output "${outputName}", mode=${DETECTOR_MODE})`,
    );
    return loaded;
  } catch (err) {
    disabledReason = `session create failed: ${(err as Error).message}`;
    return null;
  }
}

// Kick off (or retry) a background load. Returns immediately — never awaited
// by the pipeline.
export function warmDetector(): void {
  if (givenUp || loadState === "loading" || loadState === "ready") return;
  if (Date.now() < nextRetryAt) return;
  loadState = "loading";
  const started = Date.now();
  const timeout = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), MODEL_LOAD_TIMEOUT_MS).unref(),
  );
  void Promise.race([loadModel(), timeout])
    .then((model) => {
      if (model) {
        loaded = model;
        loadState = "ready";
        disabledReason = null;
        console.log(`detector: ready after ${Math.round((Date.now() - started) / 1000)}s`);
        return;
      }
      loadState = "failed";
      nextRetryAt = Date.now() + LOAD_RETRY_MS;
      disabledReason ??= `model load exceeded ${MODEL_LOAD_TIMEOUT_MS}ms`;
      console.warn(`detector: load failed (${disabledReason}) — running without it, retry in ${Math.round(LOAD_RETRY_MS / 60000)} min`);
    })
    .catch((err) => {
      loadState = "failed";
      nextRetryAt = Date.now() + LOAD_RETRY_MS;
      disabledReason = (err as Error).message;
      console.warn(`detector: load threw (${disabledReason}) — running without it`);
    });
}

export function detectorReady(): boolean {
  return loadState === "ready" && !givenUp;
}

// For CLI tools only: block until the model is loaded (or failed). The worker
// pipeline must never call this.
export async function loadDetectorNow(): Promise<boolean> {
  for (;;) {
    if (detectorReady()) return true;
    if (loadState === "failed" || givenUp) return false;
    warmDetector();
    await new Promise((r) => setTimeout(r, 250));
  }
}

export function detectorDisabledReason(): string | null {
  if (givenUp) return "disabled after repeated timeouts";
  if (loadState === "loading") return "model still loading";
  return disabledReason;
}

// Letterbox → CHW float32. YOLOX expects raw 0-255 BGR; YOLOv8 expects 0-1 RGB.
type JimpImage = Awaited<ReturnType<typeof Jimp.read>>;

function preprocess(
  img: JimpImage,
  inputW: number,
  inputH: number,
  layout: OutputLayout,
): { tensor: Float32Array; lb: ReturnType<typeof computeLetterbox> } {
  const isYolox = layout === "yolox";
  const lb = computeLetterbox(img.bitmap.width, img.bitmap.height, inputW, inputH, !isYolox);
  const resized = img.clone().resize({ w: lb.resizedW, h: lb.resizedH });
  const src = resized.bitmap.data; // RGBA
  const plane = inputW * inputH;
  const tensor = new Float32Array(3 * plane);
  // Three preprocessing conventions:
  //  - yolox (current):  BGR, raw 0-255, pad 114
  //  - yolox legacy:     RGB, /255, ImageNet mean/std, pad 114 (0.1.x weights)
  //  - yolov8:           RGB, /255, pad 114/255
  const legacy = isYolox && YOLOX_LEGACY;
  const mean = legacy ? [0.485, 0.456, 0.406] : [0, 0, 0];
  const std = legacy ? [0.229, 0.224, 0.225] : [1, 1, 1];
  const scale = isYolox && !legacy ? 1 : 1 / 255;
  const padRaw = isYolox && !legacy ? 114 : 114 / 255;
  for (let c = 0; c < 3; c++) tensor.fill((padRaw - mean[c]) / std[c], c * plane, (c + 1) * plane);
  const bgr = isYolox && !legacy;
  for (let y = 0; y < lb.resizedH; y++) {
    const oy = y + lb.padY;
    for (let x = 0; x < lb.resizedW; x++) {
      const ox = x + lb.padX;
      const s = (y * lb.resizedW + x) * 4;
      const r = src[s] * scale;
      const g = src[s + 1] * scale;
      const b = src[s + 2] * scale;
      const d = oy * inputW + ox;
      const c0 = bgr ? b : r;
      const c2 = bgr ? r : b;
      tensor[d] = (c0 - mean[0]) / std[0];
      tensor[plane + d] = (g - mean[1]) / std[1];
      tensor[2 * plane + d] = (c2 - mean[2]) / std[2];
    }
  }
  return { tensor, lb };
}

// Run the detector on an encoded image. Resolves null on any failure/timeout.
export async function detectObjects(imageBuffer: Buffer): Promise<DetectorRun | null> {
  const started = Date.now();
  // Never wait for the model here — if it is not loaded yet, this event just
  // goes to the VLM unfiltered while the load continues in the background.
  if (!detectorReady()) {
    warmDetector();
    return null;
  }
  const model = loaded;
  if (!model) return null;
  const work = (async (): Promise<DetectorRun | null> => {
    const img = await Jimp.read(imageBuffer);
    const width = img.bitmap.width;
    const height = img.bitmap.height;

    // First run: sniff the layout from a dry decode of output dims.
    let layout = model.layout;
    const runOnce = async (region: JimpImage, lay: OutputLayout) => {
      const { tensor, lb } = preprocess(region, model.inputW, model.inputH, lay);
      const feeds = {
        [model.inputName]: new model.ort.Tensor("float32", tensor, [1, 3, model.inputH, model.inputW]),
      };
      const out = await model.session.run(feeds);
      const t = out[model.outputName];
      return { t, lb };
    };
    let { t, lb } = await runOnce(img, layout ?? "yolox");
    if (!layout) {
      layout = detectLayout(t.dims as number[]);
      if (!layout) {
        disabledReason = `unrecognised output dims ${JSON.stringify(t.dims)}`;
        return null;
      }
      model.layout = layout;
      // Preprocessing differs per family; redo if the guess was wrong.
      if (layout !== "yolox") ({ t, lb } = await runOnce(img, layout));
    }
    const decodeOpts = { confThreshold: CONF_THRESHOLD, iouThreshold: IOU_THRESHOLD, layout };
    const all: ObjectDetection[] = decodeOutput(t.data as Float32Array, t.dims as number[], lb, width, height, decodeOpts);

    // Tiled passes (ADR-015): CCTV frames are wide and people are small; a
    // 2x2 grid with overlap roughly doubles their size in the model's eyes.
    // Costs TILES extra inferences — still cheap next to one VLM call.
    if (TILES === 4) {
      const ov = 0.15;
      const tw = Math.round(width * (0.5 + ov / 2));
      const th = Math.round(height * (0.5 + ov / 2));
      const origins = [
        [0, 0],
        [width - tw, 0],
        [0, height - th],
        [width - tw, height - th],
      ];
      for (const [ox, oy] of origins) {
        const tile = img.clone().crop({ x: ox, y: oy, w: tw, h: th }) as unknown as JimpImage;
        const r = await runOnce(tile, layout);
        const dets = decodeOutput(r.t.data as Float32Array, r.t.dims as number[], r.lb, tw, th, decodeOpts);
        for (const d of dets) all.push({ ...d, box: { ...d.box, x: d.box.x + ox, y: d.box.y + oy } });
      }
    }
    // Drop tile-edge slivers (a person cut in half by a tile border) that a
    // fuller box already covers, then merge duplicates across passes.
    const detections = nms(all, IOU_THRESHOLD).filter((d, _, arr) =>
      !arr.some((o) => o !== d && o.label === d.label && o.confidence >= d.confidence && containment(d.box, o.box) > 0.7),
    );
    return { detections, width, height, ms: Date.now() - started, model: model.name };
  })();

  const timeout = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), DETECTOR_TIMEOUT_MS).unref(),
  );
  try {
    const result = await Promise.race([work, timeout]);
    if (!result) {
      consecutiveTimeouts += 1;
      console.warn(
        `detector: no result within ${DETECTOR_TIMEOUT_MS}ms — fail open (${consecutiveTimeouts}/${MAX_CONSECUTIVE_TIMEOUTS})`,
      );
      if (consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) {
        givenUp = true;
        console.warn("detector: too many timeouts — disabled for this process, pipeline continues without it");
      }
    } else {
      consecutiveTimeouts = 0;
    }
    return result;
  } catch (err) {
    console.warn(`detector: failed — fail open: ${(err as Error).message}`);
    return null;
  }
}

// JPEG crop of the region around relevant detections, or null when it would
// not add information (nothing relevant / region ≈ whole frame).
export async function cropForVlm(
  imageBuffer: Buffer,
  run: DetectorRun,
): Promise<{ base64: string; mimeType: string; box: Box } | null> {
  const box = cropRegion(run.detections, run.width, run.height);
  if (!box) return null;
  try {
    const img = await Jimp.read(imageBuffer);
    const crop = img.crop({ x: box.x, y: box.y, w: box.w, h: box.h });
    // Upscale small crops so the VLM gets more pixels per person.
    if (crop.bitmap.width < 640) {
      const s = 640 / crop.bitmap.width;
      crop.resize({ w: 640, h: Math.round(crop.bitmap.height * s) });
    }
    const buf = await crop.getBuffer("image/jpeg", { quality: 85 });
    return { base64: buf.toString("base64"), mimeType: "image/jpeg", box };
  } catch (err) {
    console.warn(`detector: crop failed — sending full frame only: ${(err as Error).message}`);
    return null;
  }
}
