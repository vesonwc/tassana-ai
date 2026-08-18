import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import { Jimp } from "jimp";

// One-shot diagnostic (read-only): what resolution does the DVR's ISAPI
// /picture endpoint return for a channel, with and without an explicit
// videoResolutionWidth/Height request? Saves the JPEGs to nvr-snapshots/.
//   npx tsx worker/tools/nvr-picture-probe.ts [channel=1]

try {
  process.loadEnvFile(".env");
} catch {
  // optional
}
const HOST = process.env.NVR_HOST ?? "";
const PORT = Number(process.env.NVR_PORT ?? 80);
const USER = process.env.NVR_USER ?? "admin";
const PASS = process.env.NVR_PASSWORD ?? "";
const CH = process.argv[2] ?? "1";

const md5 = (s: string) => createHash("md5").update(s).digest("hex");

function getBuffer(path: string): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const collect = (res: http.IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
    };
    const probe = http.request({ host: HOST, port: PORT, path, method: "GET", timeout: 15_000 }, (res) => {
      if (res.statusCode !== 401) return collect(res);
      const ch = res.headers["www-authenticate"] ?? "";
      res.resume();
      const p: Record<string, string> = {};
      for (const m of ch.matchAll(/(\w+)=("([^"]*)"|([^,]*))/g)) p[m[1]] = m[3] ?? m[4];
      const qop = p.qop?.split(",")[0]?.trim();
      const nc = "00000001";
      const cnonce = randomBytes(8).toString("hex");
      const ha1 = md5(`${USER}:${p.realm}:${PASS}`);
      const ha2 = md5(`GET:${path}`);
      const resp = qop ? md5(`${ha1}:${p.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${p.nonce}:${ha2}`);
      let auth = `Digest username="${USER}", realm="${p.realm}", nonce="${p.nonce}", uri="${path}", response="${resp}"`;
      if (qop) auth += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
      if (p.opaque) auth += `, opaque="${p.opaque}"`;
      const r2 = http.request({ host: HOST, port: PORT, path, method: "GET", headers: { Authorization: auth }, timeout: 15_000 }, collect);
      r2.on("timeout", () => r2.destroy(new Error("timeout")));
      r2.on("error", reject);
      r2.end();
    });
    probe.on("timeout", () => probe.destroy(new Error("timeout")));
    probe.on("error", reject);
    probe.end();
  });
}

async function main(): Promise<void> {
  if (!HOST || !PASS) {
    console.error("NVR_HOST / NVR_PASSWORD missing in .env");
    process.exit(2);
  }
  mkdirSync("nvr-snapshots", { recursive: true });
  const variants: [string, string][] = [
    ["default", `/ISAPI/Streaming/channels/${CH}01/picture`],
    ["1920x1080", `/ISAPI/Streaming/channels/${CH}01/picture?videoResolutionWidth=1920&videoResolutionHeight=1080`],
    ["1280x720", `/ISAPI/Streaming/channels/${CH}01/picture?videoResolutionWidth=1280&videoResolutionHeight=720`],
    ["sub 02", `/ISAPI/Streaming/channels/${CH}02/picture`],
  ];
  for (const [label, path] of variants) {
    const t0 = Date.now();
    try {
      const { status, body } = await getBuffer(path);
      const ms = Date.now() - t0;
      if (status !== 200 || body.length < 1000) {
        console.log(`${label.padEnd(10)} HTTP ${status} (${body.length} bytes) ${ms}ms — ${body.toString("utf8").slice(0, 120).replace(/\s+/g, " ")}`);
        continue;
      }
      const img = await Jimp.read(body);
      const file = `nvr-snapshots/probe_ch${CH}_${label.replace(/\s/g, "")}.jpg`;
      writeFileSync(file, body);
      console.log(`${label.padEnd(10)} ${img.bitmap.width}x${img.bitmap.height}  ${(body.length / 1024).toFixed(0)} KB  ${ms}ms → ${file}`);
    } catch (err) {
      console.log(`${label.padEnd(10)} error: ${(err as Error).message}`);
    }
  }
}

main();
