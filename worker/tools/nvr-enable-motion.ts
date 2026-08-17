import { createHash, randomBytes } from "node:crypto";
import http from "node:http";

// Enable motion detection + "notify surveillance center" on chosen channels.
// Usage: npx tsx worker/tools/nvr-enable-motion.ts 1 7 16
// Read-modify-write on the NVR's own XML so we only flip the two flags we
// need and leave every other setting (grid, schedule, recording) untouched.

try { process.loadEnvFile(".env"); } catch { /* optional */ }
const HOST = process.env.NVR_HOST ?? ""; const PORT = Number(process.env.NVR_PORT ?? 80);
const USER = process.env.NVR_USER ?? "admin"; const PASS = process.env.NVR_PASSWORD ?? "";
const CHANNELS = process.argv.slice(2).map(Number).filter((n) => n >= 1 && n <= 64);
if (CHANNELS.length === 0) { console.error("usage: nvr-enable-motion.ts <ch> [ch...]"); process.exit(1); }

const md5 = (s: string) => createHash("md5").update(s).digest("hex");

function digestFor(challenge: string, method: string, path: string): string {
  const p: Record<string, string> = {};
  for (const m of challenge.matchAll(/(\w+)=("([^"]*)"|([^,]*))/g)) p[m[1]] = m[3] ?? m[4];
  const qop = p.qop?.split(",")[0]?.trim(); const nc = "00000001"; const cnonce = randomBytes(8).toString("hex");
  const ha1 = md5(`${USER}:${p.realm}:${PASS}`); const ha2 = md5(`${method}:${path}`);
  const resp = qop ? md5(`${ha1}:${p.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${p.nonce}:${ha2}`);
  let auth = `Digest username="${USER}", realm="${p.realm}", nonce="${p.nonce}", uri="${path}", response="${resp}"`;
  if (qop) auth += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`; if (p.opaque) auth += `, opaque="${p.opaque}"`;
  return auth;
}

function request(method: string, path: string, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const send = (auth?: string) => {
      const req = http.request(
        { host: HOST, port: PORT, path, method, timeout: 10_000, headers: { ...(auth ? { Authorization: auth } : {}), ...(body ? { "Content-Type": "application/xml", "Content-Length": Buffer.byteLength(body) } : {}) } },
        (res) => {
          if (res.statusCode === 401 && !auth) { const ch = res.headers["www-authenticate"] ?? ""; res.resume(); send(digestFor(ch, method, path)); return; }
          let b = ""; res.setEncoding("utf8"); res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
        },
      );
      req.on("timeout", () => req.destroy(new Error("timeout"))); req.on("error", reject);
      if (body) req.write(body); req.end();
    };
    send();
  });
}

function setTag(xml: string, tag: string, value: string): string {
  const re = new RegExp(`<${tag}>[^<]*</${tag}>`);
  return re.test(xml) ? xml.replace(re, `<${tag}>${value}</${tag}>`) : xml;
}

async function enableChannel(ch: number): Promise<void> {
  // 1) motion detection on, medium sensitivity if the field exists
  const mdPath = `/ISAPI/System/Video/inputs/channels/${ch}/motionDetection`;
  const md = await request("GET", mdPath);
  if (md.status !== 200) { console.log(`ch${ch}: อ่าน motionDetection ไม่ได้ (${md.status})`); return; }
  let mdXml = setTag(md.body, "enabled", "true");
  mdXml = mdXml.replace(/<sensitivityLevel>\d+<\/sensitivityLevel>/, "<sensitivityLevel>60</sensitivityLevel>");
  // If the grid is empty the NVR detects nothing — fill it (all cells active).
  if (/<gridMap>\s*<\/gridMap>|<gridMap\/>/.test(mdXml) || !/<gridMap>/.test(mdXml)) {
    // 22 columns x 18 rows of 'f' hex nibbles is the common full-frame map;
    // firmware ignores oversize input, so this is safe as a best effort.
    const full = "f".repeat(22 * 18 / 4 * 4);
    mdXml = /<gridMap>/.test(mdXml) ? mdXml.replace(/<gridMap>[\s\S]*?<\/gridMap>/, `<gridMap>${full}</gridMap>`) : mdXml;
  }
  const put1 = await request("PUT", mdPath, mdXml);
  const ok1 = put1.status === 200 && /statusCode>1</.test(put1.body);
  console.log(`ch${ch}: motion enabled → ${ok1 ? "✅" : `❌ ${put1.status} ${put1.body.slice(0, 120)}`}`);

  // 2) event trigger: notify surveillance center (this is what feeds alertStream)
  const trigPath = `/ISAPI/Event/triggers/VMD-${ch}`;
  const trig = await request("GET", trigPath);
  if (trig.status !== 200) { console.log(`ch${ch}: อ่าน trigger ไม่ได้ (${trig.status}) — บางรุ่นแจ้ง stream ให้เองอยู่แล้ว`); return; }
  let trigXml = trig.body;
  if (!/<notificationMethod>\s*center\s*<\/notificationMethod>/i.test(trigXml)) {
    const insert = `<EventTriggerNotification><id>center</id><notificationMethod>center</notificationMethod><notificationRecurrence>beginning</notificationRecurrence></EventTriggerNotification>`;
    trigXml = /<EventTriggerNotificationList>/.test(trigXml)
      ? trigXml.replace(/<EventTriggerNotificationList>/, `<EventTriggerNotificationList>${insert}`)
      : trigXml.replace(/<\/EventTrigger>/, `<EventTriggerNotificationList>${insert}</EventTriggerNotificationList></EventTrigger>`);
    const put2 = await request("PUT", trigPath, trigXml);
    const ok2 = put2.status === 200 && /statusCode>1</.test(put2.body);
    console.log(`ch${ch}: notify center → ${ok2 ? "✅" : `❌ ${put2.status} ${put2.body.slice(0, 120)}`}`);
  } else {
    console.log(`ch${ch}: notify center → ✅ (เปิดอยู่แล้ว)`);
  }
}

async function main(): Promise<void> {
  console.log(`เปิด motion detection บน ${HOST} ช่อง: ${CHANNELS.join(", ")}`);
  for (const ch of CHANNELS) await enableChannel(ch);
  console.log("เสร็จ — รัน nvr-probe.ts เพื่อยืนยันสถานะได้");
}
void main();
