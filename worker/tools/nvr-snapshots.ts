import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";

// Diagnostic: channel names + one snapshot per channel into a local folder.
try { process.loadEnvFile(".env"); } catch { /* optional */ }
const HOST = process.env.NVR_HOST ?? ""; const PORT = Number(process.env.NVR_PORT ?? 80);
const USER = process.env.NVR_USER ?? "admin"; const PASS = process.env.NVR_PASSWORD ?? "";
const OUT = process.argv[2] ?? "nvr-snapshots";
const md5 = (s: string) => createHash("md5").update(s).digest("hex");

function get(path: string): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const probe = http.request({ host: HOST, port: PORT, path, method: "GET", timeout: 10_000 }, (res) => {
      if (res.statusCode !== 401) { const c: Buffer[] = []; res.on("data", (d: Buffer) => c.push(d)); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(c) })); return; }
      const ch = res.headers["www-authenticate"] ?? ""; res.resume();
      const p: Record<string, string> = {}; for (const m of ch.matchAll(/(\w+)=("([^"]*)"|([^,]*))/g)) p[m[1]] = m[3] ?? m[4];
      const qop = p.qop?.split(",")[0]?.trim(); const nc = "00000001"; const cnonce = randomBytes(8).toString("hex");
      const ha1 = md5(`${USER}:${p.realm}:${PASS}`); const ha2 = md5(`GET:${path}`);
      const resp = qop ? md5(`${ha1}:${p.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${p.nonce}:${ha2}`);
      let auth = `Digest username="${USER}", realm="${p.realm}", nonce="${p.nonce}", uri="${path}", response="${resp}"`;
      if (qop) auth += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`; if (p.opaque) auth += `, opaque="${p.opaque}"`;
      const r2 = http.request({ host: HOST, port: PORT, path, method: "GET", headers: { Authorization: auth } }, (res2) => { const c: Buffer[] = []; res2.on("data", (d: Buffer) => c.push(d)); res2.on("end", () => resolve({ status: res2.statusCode ?? 0, body: Buffer.concat(c) })); });
      r2.on("error", reject); r2.end();
    });
    probe.on("timeout", () => probe.destroy(new Error("timeout"))); probe.on("error", reject); probe.end();
  });
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const names = await get("/ISAPI/System/Video/inputs/channels").catch(() => ({ status: 0, body: Buffer.alloc(0) }));
  const xml = names.body.toString("utf8");
  for (let ch = 1; ch <= 16; ch++) {
    const block = xml.match(new RegExp(`<VideoInputChannel>[\\s\\S]*?<id>${ch}</id>[\\s\\S]*?</VideoInputChannel>`))?.[0] ?? "";
    const name = block.match(/<name>([^<]*)<\/name>/)?.[1] ?? "?";
    const pic = await get(`/ISAPI/Streaming/channels/${ch}01/picture`).catch(() => ({ status: 0, body: Buffer.alloc(0) }));
    if (pic.status === 200 && pic.body.length > 1000) {
      writeFileSync(`${OUT}/ch${String(ch).padStart(2, "0")}.jpg`, pic.body);
      console.log(`ch${String(ch).padStart(2)} "${name}" ✅ ${Math.round(pic.body.length / 1024)}KB`);
    } else {
      console.log(`ch${String(ch).padStart(2)} "${name}" ❌ ไม่มีภาพ (${pic.status})`);
    }
  }
}
void main();
