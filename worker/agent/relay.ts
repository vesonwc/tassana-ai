import { createServer } from "node:http";

// On-site relay (ADR-007): the NVR cannot reach the internet directly and we
// must never port-forward it. This tiny listener runs on a PC in the same LAN,
// accepts the NVR's HTTP alert (XML, sometimes multipart+JPEG), and forwards it
// outbound to our cloud webhook. Zero inbound ports opened on the internet.
//
// Run on the on-site PC:  npx tsx worker/agent/relay.ts
// Then point the NVR's "Notify Surveillance Center / HTTP" at:
//   http://<this-pc-lan-ip>:9000/

const PORT = Number(process.env.RELAY_PORT ?? 9000);
const SITE_KEY = process.env.RELAY_SITE_KEY ?? "";
const CLOUD = (process.env.RELAY_CLOUD_URL ?? "https://tassana-ai.vercel.app").replace(/\/$/, "");

if (!SITE_KEY) {
  console.error("relay: set RELAY_SITE_KEY (the site's secret webhook key) first");
  process.exit(1);
}
const target = `${CLOUD}/api/webhook/${SITE_KEY}`;

const server = createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(200).end("tassana relay: online");
    return;
  }
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", async () => {
    const body = Buffer.concat(chunks);
    try {
      const upstream = await fetch(target, {
        method: "POST",
        headers: {
          "content-type": req.headers["content-type"] ?? "application/octet-stream",
        },
        body,
      });
      const text = await upstream.text();
      const stamp = new Date().toISOString().slice(11, 19);
      console.log(`relay ${stamp}: NVR→cloud ${upstream.status} (${body.length}B) ${text.slice(0, 80)}`);
      // Always 200 back to the NVR so it does not retry-storm on our behalf.
      res.writeHead(200).end("ok");
    } catch (err) {
      console.error("relay: forward failed", (err as Error).message);
      res.writeHead(200).end("ok"); // swallow — event is lost, but NVR must not hang
    }
  });
});

server.listen(PORT, () => {
  console.log(`tassana relay: listening on 0.0.0.0:${PORT}`);
  console.log(`  → forwarding to ${target}`);
  console.log(`  ตั้งค่า NVR ให้ยิง HTTP alert มาที่ http://<ไอพีเครื่องนี้>:${PORT}/`);
});
