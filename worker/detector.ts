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
  parseDetectorMode,
  type Box,
  type DetectorMode,
  type ObjectDetection,
  type OutputLayout,
} from "../lib/detector-core";

export const DETECTOR_MODE: DetectorMode = parseDetectorMode(process.env.YOLO_MODE);
// YOLOX-s: Apache-2.0, official Megvii release (ADR-015 §2).
const DEFAULT_MODEL_URL =
  "https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_s.onnx";
export const MODEL_PATH = process.env.YOLO_MODEL_PATH ?? "models/yolox_s.onnx";
const MODEL_URL = process.env.YOLO_MODEL_URL ?? DEFAULT_MODEL_URL;
const CONF_THRESHOLD = Number(process.env.YOLO_CONF ?? 0.35);
const IOU_THRESHOLD = Number(process.env.YOLO_IOU ?? 0.45);
export const DETECTOR_TIMEOUT_MS = Number(process.env.YOLO_TIMEOUT_MS ?? 3_000);
const LAYOUT_OVERRIDE = process.env.YOLO_LAYOUT as OutputLayout | undefined;
const THREADS = Number(process.env.YOLO_THREADS ?? 2);

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

let loading: Promise<LoadedModel | null> | null = null;
let disabledReason: string | null = null;

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

export function getDetector(): Promise<LoadedModel | null> {
  if (!loading) loading = loadModel();
  return loading;
}

export function detectorDisabledReason(): string | null {
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
  const pad = isYolox ? 114 : 114 / 255;
  tensor.fill(pad);
  const scale = isYolox ? 1 : 1 / 255;
  for (let y = 0; y < lb.resizedH; y++) {
    const oy = y + lb.padY;
    for (let x = 0; x < lb.resizedW; x++) {
      const ox = x + lb.padX;
      const s = (y * lb.resizedW + x) * 4;
      const r = src[s] * scale;
      const g = src[s + 1] * scale;
      const b = src[s + 2] * scale;
      const d = oy * inputW + ox;
      // channel order: BGR for YOLOX (cv2 convention), RGB otherwise
      tensor[d] = isYolox ? b : r;
      tensor[plane + d] = g;
      tensor[2 * plane + d] = isYolox ? r : b;
    }
  }
  return { tensor, lb };
}

// Run the detector on an encoded image. Resolves null on any failure/timeout.
export async function detectObjects(imageBuffer: Buffer): Promise<DetectorRun | null> {
  const started = Date.now();
  const model = await getDetector();
  if (!model) return null;
  const work = (async (): Promise<DetectorRun | null> => {
    const img = await Jimp.read(imageBuffer);
    const width = img.bitmap.width;
    const height = img.bitmap.height;

    // First run: sniff the layout from a dry decode of output dims.
    let layout = model.layout;
    const runOnce = async (lay: OutputLayout) => {
      const { tensor, lb } = preprocess(img, model.inputW, model.inputH, lay);
      const feeds = {
        [model.inputName]: new model.ort.Tensor("float32", tensor, [1, 3, model.inputH, model.inputW]),
      };
      const out = await model.session.run(feeds);
      const t = out[model.outputName];
      return { t, lb };
    };
    let { t, lb } = await runOnce(layout ?? "yolox");
    if (!layout) {
      layout = detectLayout(t.dims as number[]);
      if (!layout) {
        disabledReason = `unrecognised output dims ${JSON.stringify(t.dims)}`;
        return null;
      }
      model.layout = layout;
      // Preprocessing differs per family; redo if the guess was wrong.
      if (layout !== "yolox") ({ t, lb } = await runOnce(layout));
    }
    const detections = decodeOutput(t.data as Float32Array, t.dims as number[], lb, width, height, {
      confThreshold: CONF_THRESHOLD,
      iouThreshold: IOU_THRESHOLD,
      layout,
    });
    return { detections, width, height, ms: Date.now() - started, model: model.name };
  })();

  const timeout = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), DETECTOR_TIMEOUT_MS).unref(),
  );
  try {
    const result = await Promise.race([work, timeout]);
    if (!result) console.warn(`detector: no result within ${DETECTOR_TIMEOUT_MS}ms — fail open`);
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
