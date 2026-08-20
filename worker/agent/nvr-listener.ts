import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import { sceneChanged } from "../../lib/scene-change";
import { detectObjects, detectorReady, loadDetectorNow } from "../detector";
import { summarizeLabels, type ObjectDetection } from "../../lib/detector-core";

// On-site NVR listener (M6, mode A without touching NVR menus).
// Logs into a Hikvision/HiLook NVR over the LAN with HTTP Digest auth,
// subscribes to the ISAPI alert stream, and forwards each event (plus a fresh
// snapshot of that channel) to our cloud webhook — outbound only (ADR-007).
//
// Credentials come from .env, typed by the site owner, never from chat.
//   NVR_HOST=192.168.1.164   NVR_USER=admin   NVR_PASSWORD=...
//   NVR_WEBHOOK_URL=https://tassana-ai.vercel.app/api/webhook/<siteKey>
// Run: npx tsx worker/agent/nvr-listener.ts

try {
  process.loadEnvFile(".env");
} catch {
  // optional
}

const HOST = process.env.NVR_HOST ?? "";
const PORT = Number(process.env.NVR_PORT ?? 80);
const USER = process.env.NVR_USER ?? "admin";
const PASS = process.env.NVR_PASSWORD ?? "";
const WEBHOOK = process.env.NVR_WEBHOOK_URL ?? "";
const HEARTBEAT_EVERY_MS = 5 * 60_000;
// Per-channel cooldown. Busy office hours: motion fires nonstop while people
// simply work — one look every few minutes is plenty. Off-hours: react fast.
// 15 min busy default (was 3): measured 2026-08-18 on the HQ site, 3 cameras at
// 3 min burned the Gemini free tier (500/day) by 09:00; 15 min keeps a 24h site
// around ~300 VLM calls/day. Serious events (intrusion etc.) bypass cooldown.
const COOLDOWN_BUSY_MS = Number(process.env.NVR_COOLDOWN_BUSY_MS ?? 15 * 60_000);
const COOLDOWN_QUIET_MS = Number(process.env.NVR_COOLDOWN_QUIET_MS ?? 30_000);
const BUSY_START = process.env.NVR_BUSY_START ?? "08:00";
const BUSY_END = process.env.NVR_BUSY_END ?? "19:00";
// Frames that barely changed since the last one we sent are not worth a call.
// The histogram test is coarse — an office scene keeps near-identical colour
// stats while people move — so the bar is set low, and a forced refresh
// guarantees the cloud still sees every channel at least periodically.
const MIN_FRAME_DIFF_PCT = Number(process.env.NVR_MIN_FRAME_DIFF ?? 1.5);
const FORCE_SEND_EVERY_MS = Number(process.env.NVR_FORCE_SEND_MS ?? 30 * 60_000);
// ADR-017: run the object detector here instead of trusting a blind cooldown.
// Off by default so a bridge PC that has not been updated behaves as before.
const YOLO_ON = process.env.NVR_YOLO === "1";
// ADR-017 (แก้ 2026-08-20): งบการวิเคราะห์มีจำกัด จึงจัดสรรตามคุณค่า —
// กลางวันออฟฟิศคนเดินตลอด ภาพ "เปลี่ยน" ทุก 20 วิ แต่แทบไม่มีอะไรน่าสนใจ;
// กลางคืนคนเดียวที่เดินผ่านคือเรื่องสำคัญ. ตัวตรวจจับจึงใช้ "ลัดคิว" เมื่อมี
// ของใหม่โผล่ ไม่ใช่ใช้ยกเลิกการเว้นระยะทั้งหมด.
const NIGHT_START = Number(process.env.NVR_NIGHT_START ?? 19);
const NIGHT_END = Number(process.env.NVR_NIGHT_END ?? 7);
const DAY_FLOOR_MS = Number(process.env.NVR_DAY_FLOOR_MS ?? 12 * 60_000);
// 5 นาที (เจ้าของกำหนด 2026-08-20): การบุกรุก/ขโมยจริงใช้เวลานานกว่านั้นเสมอ
// จึงไม่ต้องเก็บทุกเฟรม — และการ "มาใหม่" ยังลัดคิวได้ทันทีอยู่แล้ว ภาพแรก
// ที่คนโผล่เข้ามาในลานว่างจึงไม่ถูกหน่วงเลย ที่ลดลงคือเฟรมตามหลังเท่านั้น
const NIGHT_FLOOR_MS = Number(process.env.NVR_NIGHT_FLOOR_MS ?? 5 * 60_000);

function isNightBangkok(): boolean {
  const h = Number(new Date().toLocaleString("en-GB", { timeZone: "Asia/Bangkok", hour: "2-digit", hour12: false }));
  return NIGHT_START > NIGHT_END ? h >= NIGHT_START || h < NIGHT_END : h >= NIGHT_START && h < NIGHT_END;
}

function bangkokHHmm(): string {
  return new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit" });
}
function isBusyHours(): boolean {
  const now = bangkokHHmm();
  const day = new Date().toLocaleDateString("en-US", { timeZone: "Asia/Bangkok", weekday: "short" });
  if (day === "Sat" || day === "Sun") return false;
  return now >= BUSY_START && now < BUSY_END;
}

// Cheap similarity: compare downscaled JPEG byte histograms. Not vision, but
// enough to skip "same people at same desks" frames without any dependency.
function frameDiffPct(a: Buffer, b: Buffer): number {
  const bins = 64;
  const ha = new Array<number>(bins).fill(0);
  const hb = new Array<number>(bins).fill(0);
  const stepA = Math.max(1, Math.floor(a.length / 20_000));
  const stepB = Math.max(1, Math.floor(b.length / 20_000));
  for (let i = 0; i < a.length; i += stepA) ha[a[i] >> 2] += 1;
  for (let i = 0; i < b.length; i += stepB) hb[b[i] >> 2] += 1;
  const na = ha.reduce((s, v) => s + v, 0) || 1;
  const nb = hb.reduce((s, v) => s + v, 0) || 1;
  let diff = 0;
  for (let i = 0; i < bins; i++) diff += Math.abs(ha[i] / na - hb[i] / nb);
  return (diff / 2) * 100;
}

if (!HOST || !PASS || !WEBHOOK) {
  console.error(
    "nvr-listener: กรุณาใส่ NVR_HOST, NVR_PASSWORD, NVR_WEBHOOK_URL ในไฟล์ .env ก่อน",
  );
  process.exit(1);
}

// ---------------------------------------------------------------- digest auth
function md5(s: string): string {
  return createHash("md5").update(s).digest("hex");
}

function buildDigest(
  challenge: string,
  method: string,
  uri: string,
): string {
  const params: Record<string, string> = {};
  for (const m of challenge.matchAll(/(\w+)=("([^"]*)"|([^,]*))/g)) {
    params[m[1]] = m[3] ?? m[4];
  }
  const realm = params.realm ?? "";
  const nonce = params.nonce ?? "";
  const qop = params.qop?.split(",")[0]?.trim();
  const opaque = params.opaque;
  const nc = "00000001";
  const cnonce = randomBytes(8).toString("hex");
  const ha1 = md5(`${USER}:${realm}:${PASS}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = qop
    ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`);
  let header =
    `Digest username="${USER}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`;
  if (qop) header += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  if (opaque) header += `, opaque="${opaque}"`;
  return header;
}

// Two-step request: unauthenticated probe → 401 with challenge → retry signed.
function nvrRequest(
  path: string,
  onResponse: (res: http.IncomingMessage) => void,
  onError: (err: Error) => void,
): void {
  const probe = http.request(
    { host: HOST, port: PORT, path, method: "GET", timeout: 15_000 },
    (res) => {
      if (res.statusCode === 401) {
        const challenge = res.headers["www-authenticate"] ?? "";
        res.resume();
        if (!/^Digest/i.test(challenge)) {
          onError(new Error(`NVR ต้องการ auth แบบที่ไม่รองรับ: ${challenge.slice(0, 40)}`));
          return;
        }
        const signed = http.request(
          {
            host: HOST,
            port: PORT,
            path,
            method: "GET",
            headers: { Authorization: buildDigest(challenge, "GET", path) },
          },
          onResponse,
        );
        signed.on("error", onError);
        signed.end();
      } else {
        onResponse(res);
      }
    },
  );
  probe.on("timeout", () => probe.destroy(new Error("NVR ไม่ตอบ (timeout)")));
  probe.on("error", onError);
  probe.end();
}

function fetchBuffer(path: string): Promise<{ status: number; body: Buffer; type: string }> {
  return new Promise((resolve, reject) => {
    nvrRequest(
      path,
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks),
            type: String(res.headers["content-type"] ?? ""),
          }),
        );
        res.on("error", reject);
      },
      reject,
    );
  });
}

// ---------------------------------------------------------------- forwarding
const lastSeen = new Map<string, number>();
const lastFrame = new Map<string, Buffer>();
const lastSent = new Map<string, number>();
// Last detector reading actually forwarded, per channel (ADR-017).
const lastDetections = new Map<string, ObjectDetection[]>();
let skippedCooldown = 0;
let skippedSimilar = 0;
let sentCount = 0;

function xmlField(xml: string, tag: string): string {
  return xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, "i"))?.[1]?.trim() ?? "";
}

async function forwardEvent(xml: string): Promise<void> {
  const eventType = xmlField(xml, "eventType");
  const state = xmlField(xml, "eventState");
  const channel = xmlField(xml, "channelID") || xmlField(xml, "dynChannelID") || "0";

  // The stream carries a videoloss "heartbeat" every few seconds; skip it, and
  // only act on the leading edge of an alarm.
  if (!eventType || eventType.toLowerCase() === "videoloss") return;
  if (state && state.toLowerCase() !== "active") return;
  const key = `${eventType}:${channel}`;
  const now = Date.now();
  PULSE_CHANNELS.add(Number(channel));
  // Hard floor regardless of mode: the DVR re-fires the same alarm several
  // times a second while motion continues; never forward faster than this.
  if (now - (lastSent.get(channel) ?? 0) < 20_000) {
    skippedCooldown += 1;
    return;
  }
  // Serious events (line crossing / intrusion) always get through fast.
  const serious = /linedetection|fielddetection|intrusion/i.test(eventType);
  // ADR-017: with the local detector running, the blind time cooldown is
  // replaced by "did the picture actually change?". Without it (or if it failed
  // to load) we keep the old time-based behaviour exactly as before.
  const useDetector = YOLO_ON && detectorReady();
  if (!useDetector) {
    const cooldown = serious ? COOLDOWN_QUIET_MS : isBusyHours() ? COOLDOWN_BUSY_MS : COOLDOWN_QUIET_MS;
    if (now - (lastSeen.get(key) ?? 0) < cooldown) {
      skippedCooldown += 1;
      return;
    }
  }

  // Grab a fresh frame from that channel's main stream.
  let image: Buffer | null = null;
  try {
    const pic = await fetchBuffer(`/ISAPI/Streaming/channels/${channel}01/picture`);
    if (pic.status === 200 && pic.body.length > 1000) image = pic.body;
  } catch (err) {
    console.warn(`nvr-listener: snapshot ch${channel} failed:`, (err as Error).message);
  }

  // Same scene as last time we sent for this channel? Not worth an AI call —
  // unless it has been a while, in which case send anyway so the channel never
  // goes silent on the dashboard just because the room looks the same.
  const staleForMs = now - (lastSent.get(channel) ?? 0);
  const mustRefresh = staleForMs >= FORCE_SEND_EVERY_MS;
  if (image && !serious && !mustRefresh) {
    if (useDetector) {
      // ADR-017: content decides *when within the budget*, not whether there is
      // a budget at all. Daytime keeps a long floor (an office simply has people
      // in it); night lets almost any change through.
      const run = await detectObjects(image);
      if (run) {
        const night = isNightBangkok();
        const floorMs = night ? NIGHT_FLOOR_MS : DAY_FLOOR_MS;
        const prev = lastDetections.get(channel) ?? null;
        const verdict = sceneChanged(prev, run.detections);
        const withinFloor = staleForMs < floorMs;
        // Inside the floor only an arrival gets through; movement waits.
        const pass = verdict.changed && (!withinFloor || verdict.significant);
        if (!pass) {
          skippedSimilar += 1;
          lastSeen.set(key, now);
          // Remember what we saw even when not sending, so the next comparison
          // is against reality rather than a stale frame from minutes ago.
          lastDetections.set(channel, run.detections);
          return;
        }
        console.log(
          `nvr-listener: ch${channel} ส่ง (${verdict.reason}${verdict.significant ? " · ของใหม่" : ""}, ${night ? "กลางคืน" : "กลางวัน"}) — ${summarizeLabels(run.detections)} [${run.ms}ms]`,
        );
        lastDetections.set(channel, run.detections);
      }
      // run === null → detector unavailable this time: fall through and send.
    } else {
      const prev = lastFrame.get(channel);
      if (prev && frameDiffPct(prev, image) < MIN_FRAME_DIFF_PCT) {
        skippedSimilar += 1;
        lastSeen.set(key, now); // still counts as "seen" so we don't spin
        return;
      }
    }
  }
  if (image) lastFrame.set(channel, image);
  lastSeen.set(key, now);
  lastSent.set(channel, now);
  sentCount += 1;

  const form = new FormData();
  form.append("event", new Blob([xml], { type: "application/xml" }), "event.xml");
  if (image) {
    form.append("image", new Blob([new Uint8Array(image)], { type: "image/jpeg" }), "snapshot.jpg");
  }
  try {
    const res = await fetch(WEBHOOK, { method: "POST", body: form });
    const text = await res.text();
    console.log(
      `nvr-listener: ${eventType} ch${channel} ${image ? "+รูป" : "ไม่มีรูป"} → cloud ${res.status} ${text.slice(0, 60)}`,
    );
  } catch (err) {
    console.error("nvr-listener: forward failed:", (err as Error).message);
  }
}

// ---------------------------------------------------------------- liveness pulse
// "No events" is not "camera dead" — a quiet room is quiet. Real liveness is
// "the NVR still answers and this channel still returns a frame". Pulse that
// to the cloud every minute so heartbeat judges presence, not activity.
const PULSE_CHANNELS = new Set<number>();
async function pulseLiveness(): Promise<void> {
  const alive: number[] = [];
  for (const ch of PULSE_CHANNELS) {
    try {
      const pic = await fetchBuffer(`/ISAPI/Streaming/channels/${ch}01/picture`);
      if (pic.status === 200 && pic.body.length > 1000) alive.push(ch);
    } catch {
      // channel down or NVR unreachable — simply not in the alive list
    }
  }
  try {
    await fetch(WEBHOOK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ test_source: "hikvision_isapi", heartbeat: true, channels: alive }),
    });
  } catch (err) {
    console.warn("nvr-listener: pulse failed:", (err as Error).message);
  }
}

// ---------------------------------------------------------------- night patrol
// "Lights left on" produces no motion, so the NVR never fires. Like a guard's
// walk-round, we snapshot every patrol channel on a schedule and let the VLM
// judge the *state* of the room (lights, doors, stragglers).
const PATROL_CHANNELS = (process.env.NVR_PATROL_CHANNELS ?? "")
  .split(",").map((s) => Number(s.trim())).filter((n) => n >= 1);
const PATROL_TIMES = (process.env.NVR_PATROL_TIMES ?? "19:30,22:00,00:00,03:00")
  .split(",").map((s) => s.trim()).filter(Boolean);
let lastPatrolKey = "";

async function runPatrol(label: string): Promise<void> {
  console.log(`nvr-listener: 🔦 ตรวจเวร ${label} — ${PATROL_CHANNELS.length} กล้อง`);
  for (const ch of PATROL_CHANNELS) {
    try {
      const pic = await fetchBuffer(`/ISAPI/Streaming/channels/${ch}01/picture`);
      if (pic.status !== 200 || pic.body.length < 1000) continue;
      const form = new FormData();
      const xml = `<EventNotificationAlert><eventType>patrol</eventType><eventState>active</eventState><channelID>${ch}</channelID><dateTime>${new Date().toISOString()}</dateTime><eventDescription>night patrol ${label}</eventDescription></EventNotificationAlert>`;
      form.append("event", new Blob([xml], { type: "application/xml" }), "event.xml");
      form.append("image", new Blob([new Uint8Array(pic.body)], { type: "image/jpeg" }), "snapshot.jpg");
      const res = await fetch(WEBHOOK, { method: "POST", body: form });
      console.log(`nvr-listener: 🔦 ch${ch} → cloud ${res.status}`);
    } catch (err) {
      console.warn(`nvr-listener: patrol ch${ch} failed:`, (err as Error).message);
    }
  }
}

function patrolTick(): void {
  if (PATROL_CHANNELS.length === 0) return;
  const now = bangkokHHmm();
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" });
  for (const t of PATROL_TIMES) {
    const key = `${today} ${t}`;
    if (now === t && lastPatrolKey !== key) {
      lastPatrolKey = key;
      void runPatrol(t);
    }
  }
}

// ---------------------------------------------------------------- stream
function subscribe(): void {
  console.log(`nvr-listener: เชื่อมต่อ ${HOST}:${PORT} ...`);
  nvrRequest(
    "/ISAPI/Event/notification/alertStream",
    (res) => {
      if (res.statusCode !== 200) {
        console.error(`nvr-listener: NVR ตอบ ${res.statusCode} — เช็ก user/รหัสผ่านใน .env`);
        res.resume();
        setTimeout(subscribe, 10_000);
        return;
      }
      console.log("nvr-listener: ✅ ต่อ event stream สำเร็จ กำลังฟังเหตุการณ์...");
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        // Multipart stream: pull out each complete XML document as it lands.
        let start = buffer.indexOf("<EventNotificationAlert");
        while (start !== -1) {
          const end = buffer.indexOf("</EventNotificationAlert>", start);
          if (end === -1) break;
          const xml = buffer.slice(start, end + "</EventNotificationAlert>".length);
          buffer = buffer.slice(end + "</EventNotificationAlert>".length);
          void forwardEvent(xml);
          start = buffer.indexOf("<EventNotificationAlert");
        }
        if (buffer.length > 200_000) buffer = buffer.slice(-50_000);
      });
      res.on("end", () => {
        console.warn("nvr-listener: stream ปิด — ต่อใหม่ใน 5 วิ");
        setTimeout(subscribe, 5_000);
      });
      res.on("error", (err) => {
        console.error("nvr-listener: stream error:", err.message);
        setTimeout(subscribe, 5_000);
      });
    },
    (err) => {
      console.error("nvr-listener: ต่อไม่ได้:", err.message, "— ลองใหม่ใน 10 วิ");
      setTimeout(subscribe, 10_000);
    },
  );
}

async function main(): Promise<void> {
  // ADR-017: load the detector before streaming so the very first events are
  // already judged by content. Failure is not fatal — we fall back to cooldown.
  if (YOLO_ON) {
    console.log("nvr-listener: กำลังโหลดตัวตรวจจับ (YOLO) …");
    const ok = await loadDetectorNow();
    console.log(
      ok
        ? "nvr-listener: ตัวตรวจจับพร้อม — ใช้ \"ภาพเปลี่ยนจริงไหม\" แทน cooldown ตามเวลา"
        : "nvr-listener: ตัวตรวจจับใช้ไม่ได้ — กลับไปใช้ cooldown ตามเวลาเหมือนเดิม",
    );
  }

  // Sanity check: device info proves host + credentials before we stream.
  try {
    const info = await fetchBuffer("/ISAPI/System/deviceInfo");
    if (info.status === 200) {
      const xml = info.body.toString("utf8");
      console.log(
        `nvr-listener: พบเครื่อง "${xmlField(xml, "deviceName")}" รุ่น ${xmlField(xml, "model")} (${xmlField(xml, "deviceType")})`,
      );
    } else if (info.status === 401) {
      console.error("nvr-listener: ❌ รหัสผ่านไม่ถูกต้อง (401) — แก้ NVR_PASSWORD ใน .env");
      process.exit(1);
    } else {
      console.warn(`nvr-listener: deviceInfo ตอบ ${info.status} — ลองต่อ stream ต่อไป`);
    }
  } catch (err) {
    console.error("nvr-listener: ติดต่อ NVR ไม่ได้:", (err as Error).message);
    process.exit(1);
  }
  subscribe();
  for (const ch of PATROL_CHANNELS) PULSE_CHANNELS.add(ch);
  setInterval(() => void pulseLiveness(), 60_000);
  if (PATROL_CHANNELS.length > 0) {
    console.log(`nvr-listener: ตรวจเวรดึกเปิดใช้ — กล้อง ${PATROL_CHANNELS.join(",")} เวลา ${PATROL_TIMES.join(", ")}`);
    setInterval(patrolTick, 30_000);
  }
  setInterval(() => {
    console.log(
      `nvr-listener: alive — ${YOLO_ON && detectorReady() ? `โหมดตรวจจับภาพ (${isNightBangkok() ? `กลางคืน ทุก ${Math.round(NIGHT_FLOOR_MS / 1000)} วิ` : `กลางวัน ทุก ${Math.round(DAY_FLOOR_MS / 60_000)} นาที`})` : isBusyHours() ? `เวลางาน (cooldown ${Math.round(COOLDOWN_BUSY_MS / 60_000)} นาที/ช่อง)` : `นอกเวลางาน (cooldown ${Math.round(COOLDOWN_QUIET_MS / 1000)} วิ)`} | ส่งแล้ว ${sentCount} | ข้าม: cooldown ${skippedCooldown}, ภาพซ้ำ ${skippedSimilar}`,
    );
  }, HEARTBEAT_EVERY_MS);
}

void main();
