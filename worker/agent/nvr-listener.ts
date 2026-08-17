import { createHash, randomBytes } from "node:crypto";
import http from "node:http";

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
const COOLDOWN_BUSY_MS = Number(process.env.NVR_COOLDOWN_BUSY_MS ?? 3 * 60_000);
const COOLDOWN_QUIET_MS = Number(process.env.NVR_COOLDOWN_QUIET_MS ?? 30_000);
const BUSY_START = process.env.NVR_BUSY_START ?? "08:00";
const BUSY_END = process.env.NVR_BUSY_END ?? "19:00";
// Frames that barely changed since the last one we sent are not worth a call.
const MIN_FRAME_DIFF_PCT = Number(process.env.NVR_MIN_FRAME_DIFF ?? 4);

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
let skippedCooldown = 0;
let skippedSimilar = 0;

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
  // Serious events (line crossing / intrusion) always get through fast.
  const serious = /linedetection|fielddetection|intrusion/i.test(eventType);
  const cooldown = serious ? COOLDOWN_QUIET_MS : isBusyHours() ? COOLDOWN_BUSY_MS : COOLDOWN_QUIET_MS;
  if (now - (lastSeen.get(key) ?? 0) < cooldown) {
    skippedCooldown += 1;
    return;
  }

  // Grab a fresh frame from that channel's main stream.
  let image: Buffer | null = null;
  try {
    const pic = await fetchBuffer(`/ISAPI/Streaming/channels/${channel}01/picture`);
    if (pic.status === 200 && pic.body.length > 1000) image = pic.body;
  } catch (err) {
    console.warn(`nvr-listener: snapshot ch${channel} failed:`, (err as Error).message);
  }

  // Same scene as last time we sent for this channel? Not worth an AI call.
  if (image && !serious) {
    const prev = lastFrame.get(channel);
    if (prev && frameDiffPct(prev, image) < MIN_FRAME_DIFF_PCT) {
      skippedSimilar += 1;
      lastSeen.set(key, now); // still counts as "seen" so we don't spin
      return;
    }
    lastFrame.set(channel, image);
  }
  lastSeen.set(key, now);

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
  setInterval(() => {
    console.log(
      `nvr-listener: alive — ${isBusyHours() ? "เวลางาน (cooldown 3 นาที/ช่อง)" : "นอกเวลางาน (cooldown 30 วิ)"} | ข้าม: cooldown ${skippedCooldown}, ภาพซ้ำ ${skippedSimilar}`,
    );
  }, HEARTBEAT_EVERY_MS);
}

void main();
