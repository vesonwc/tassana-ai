import { createHash, randomBytes } from "node:crypto";
import http from "node:http";

// One-shot diagnostic: which channels have motion detection enabled on the NVR?
// Reads credentials from .env; prints a per-channel table. Nothing is changed.

try {
  process.loadEnvFile(".env");
} catch {
  // optional
}
const HOST = process.env.NVR_HOST ?? "";
const PORT = Number(process.env.NVR_PORT ?? 80);
const USER = process.env.NVR_USER ?? "admin";
const PASS = process.env.NVR_PASSWORD ?? "";

const md5 = (s: string) => createHash("md5").update(s).digest("hex");

function get(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const probe = http.request({ host: HOST, port: PORT, path, method: "GET", timeout: 10_000 }, (res) => {
      if (res.statusCode !== 401) {
        let b = ""; res.setEncoding("utf8"); res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
        return;
      }
      const ch = res.headers["www-authenticate"] ?? ""; res.resume();
      const p: Record<string, string> = {};
      for (const m of ch.matchAll(/(\w+)=("([^"]*)"|([^,]*))/g)) p[m[1]] = m[3] ?? m[4];
      const qop = p.qop?.split(",")[0]?.trim(); const nc = "00000001"; const cnonce = randomBytes(8).toString("hex");
      const ha1 = md5(`${USER}:${p.realm}:${PASS}`); const ha2 = md5(`GET:${path}`);
      const resp = qop ? md5(`${ha1}:${p.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${p.nonce}:${ha2}`);
      let auth = `Digest username="${USER}", realm="${p.realm}", nonce="${p.nonce}", uri="${path}", response="${resp}"`;
      if (qop) auth += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`; if (p.opaque) auth += `, opaque="${p.opaque}"`;
      const r2 = http.request({ host: HOST, port: PORT, path, method: "GET", headers: { Authorization: auth } }, (res2) => {
        let b = ""; res2.setEncoding("utf8"); res2.on("data", (c) => (b += c)); res2.on("end", () => resolve({ status: res2.statusCode ?? 0, body: b }));
      });
      r2.on("error", reject); r2.end();
    });
    probe.on("timeout", () => probe.destroy(new Error("timeout"))); probe.on("error", reject); probe.end();
  });
}

const field = (xml: string, tag: string) => xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, "i"))?.[1]?.trim() ?? "";

// Exit codes (used by setup-office-pc.ps1, which must not depend on parsing Thai text):
//   0 = reached NVR and credentials accepted on at least one channel
//   2 = NVR reachable but credentials rejected (401)
//   3 = NVR unreachable / no ISAPI answer
async function main(): Promise<void> {
  console.log(`ตรวจ NVR ${HOST} — สถานะตรวจจับความเคลื่อนไหวรายช่อง:`);
  console.log("ช่อง | motion | ยิงแจ้งเตือน (notify center) | หมายเหตุ");
  let ok = 0, unauthorized = 0;
  for (let ch = 1; ch <= 16; ch++) {
    const md = await get(`/ISAPI/System/Video/inputs/channels/${ch}/motionDetection`).catch(() => ({ status: 0, body: "" }));
    if (md.status === 401) unauthorized++;
    if (md.status === 200) ok++;
    if (md.status !== 200) { console.log(`${String(ch).padStart(4)} | -      | -    | ISAPI ตอบ ${md.status || "ไม่ตอบ"}`); continue; }
    const enabled = field(md.body, "enabled");
    const trig = await get(`/ISAPI/Event/triggers/VMD-${ch}`).catch(() => ({ status: 0, body: "" }));
    const notifyCenter = /<notificationMethod>\s*center\s*<\/notificationMethod>/i.test(trig.body) ? "เปิด" : "ปิด/ไม่พบ";
    console.log(`${String(ch).padStart(4)} | ${enabled === "true" ? "เปิด ✅" : "ปิด ❌"} | ${notifyCenter.padEnd(11)} |`);
  }
  console.log("\nสรุป: motion 'ปิด' = กล้องช่องนั้นไม่ตรวจจับอะไรเลย ต้องเปิดก่อนถึงจะมี event");
  if (ok > 0) process.exitCode = 0;
  else if (unauthorized > 0) { console.log("❌ DVR ปฏิเสธรหัสผ่าน (401)"); process.exitCode = 2; }
  else { console.log(`❌ ต่อ DVR ที่ ${HOST}:${PORT} ไม่ได้`); process.exitCode = 3; }
}
void main();
