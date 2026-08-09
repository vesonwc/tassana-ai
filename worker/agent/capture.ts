import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { Jimp } from "jimp";

// PC edge agent (dev rig): DJI Pocket 3 in webcam mode → grab frames via
// ffmpeg/dshow → pixel-diff motion detection → upload snapshot → POST webhook.
// Simulates what a Frigate edge box does in mode B, using the "manual" adapter.

try {
  process.loadEnvFile(".env");
} catch {
  // optional
}

const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const DEVICE_HINT = process.env.CAMERA_DEVICE ?? ""; // exact dshow name wins
const WEBHOOK_URL =
  process.env.AGENT_WEBHOOK_URL ??
  "https://tassana-ai.vercel.app/api/webhook/dev-site-key-please-rotate";
const CAMERA_REF = process.env.AGENT_CAMERA_REF ?? "pocket3";
const INTERVAL_MS = Number(process.env.AGENT_INTERVAL_MS ?? 1500);
const MOTION_THRESHOLD_PCT = Number(process.env.AGENT_MOTION_THRESHOLD ?? 6);
const COOLDOWN_MS = Number(process.env.AGENT_COOLDOWN_MS ?? 15_000);

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("agent: missing Supabase env vars, exiting");
  process.exit(1);
}
const supabase = createClient(url, key, { auth: { persistSession: false } });

function run(
  args: string[],
): Promise<{ stdout: Buffer; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args, { windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    proc.stdout.on("data", (d: Buffer) => out.push(d));
    proc.stderr.on("data", (d: Buffer) => err.push(d));
    proc.on("error", reject);
    proc.on("close", (code) =>
      resolve({
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err).toString("utf8"),
        code: code ?? -1,
      }),
    );
  });
}

async function listVideoDevices(): Promise<string[]> {
  const { stderr } = await run([
    "-hide_banner",
    "-list_devices",
    "true",
    "-f",
    "dshow",
    "-i",
    "dummy",
  ]);
  const devices: string[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    const match = line.match(/"([^"]+)"\s*\((video[^)]*)\)/);
    if (match) devices.push(match[1]);
  }
  return devices;
}

async function pickDevice(): Promise<string> {
  const devices = await listVideoDevices();
  if (devices.length === 0) {
    throw new Error(
      "no video devices found — is the camera plugged in and set to webcam mode?",
    );
  }
  console.log("agent: video devices:", devices.join(" | "));
  if (DEVICE_HINT) {
    const exact = devices.find((d) => d === DEVICE_HINT);
    if (exact) return exact;
  }
  const pocket = devices.find((d) => /pocket|osmo|dji/i.test(d));
  return pocket ?? devices[0];
}

async function grabFrame(device: string): Promise<Buffer> {
  const { stdout, stderr, code } = await run([
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "dshow",
    "-i",
    `video=${device}`,
    "-frames:v",
    "1",
    "-f",
    "image2pipe",
    "-vcodec",
    "mjpeg",
    "pipe:1",
  ]);
  if (code !== 0 || stdout.length === 0) {
    throw new Error(`frame grab failed: ${stderr.slice(0, 300)}`);
  }
  return stdout;
}

// Mean absolute luma difference (%) between two frames, on a 64px thumbnail.
async function motionPercent(a: Buffer, b: Buffer): Promise<number> {
  const [imgA, imgB] = await Promise.all([Jimp.read(a), Jimp.read(b)]);
  imgA.resize({ w: 64, h: 36 }).greyscale();
  imgB.resize({ w: 64, h: 36 }).greyscale();
  const dataA = imgA.bitmap.data;
  const dataB = imgB.bitmap.data;
  let total = 0;
  let count = 0;
  for (let i = 0; i < Math.min(dataA.length, dataB.length); i += 4) {
    total += Math.abs(dataA[i] - dataB[i]);
    count += 1;
  }
  return count === 0 ? 0 : (total / count / 255) * 100;
}

async function reportMotion(frame: Buffer, pct: number): Promise<void> {
  const now = new Date();
  const path = `dev/${CAMERA_REF}/${now.toISOString().replace(/[:.]/g, "-")}.jpg`;
  const { error: uploadError } = await supabase.storage
    .from("snapshots")
    .upload(path, frame, { contentType: "image/jpeg" });
  if (uploadError) {
    throw new Error(`snapshot upload failed: ${uploadError.message}`);
  }

  const response = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      test_source: "manual",
      event_type: "unknown",
      camera_ref: CAMERA_REF,
      occurred_at: now.toISOString(),
      snapshot_path: path,
      raw_id: randomUUID(),
      note: `motion ${pct.toFixed(1)}%`,
    }),
  });
  const body = (await response.json()) as { event_id?: string };
  console.log(
    `agent: motion ${pct.toFixed(1)}% → event ${body.event_id ?? "?"} (HTTP ${response.status})`,
  );
}

async function main(): Promise<void> {
  const device = await pickDevice();
  console.log(`agent: using device "${device}", threshold ${MOTION_THRESHOLD_PCT}%, cooldown ${COOLDOWN_MS}ms`);

  let previous: Buffer | null = null;
  let lastReportAt = 0;
  for (;;) {
    try {
      const frame = await grabFrame(device);
      if (previous) {
        const pct = await motionPercent(previous, frame);
        const cooledDown = Date.now() - lastReportAt > COOLDOWN_MS;
        if (pct >= MOTION_THRESHOLD_PCT && cooledDown) {
          lastReportAt = Date.now();
          await reportMotion(frame, pct);
        }
      }
      previous = frame;
    } catch (err) {
      console.error("agent:", (err as Error).message);
      await new Promise((r) => setTimeout(r, 5000));
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

void main();
