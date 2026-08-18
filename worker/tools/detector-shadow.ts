import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { detectObjects, detectorDisabledReason, MODEL_PATH } from "../detector";
import { decideGate, summarizeLabels } from "../../lib/detector-core";
import type { AiResult } from "../../lib/types";

// ADR-015 offline shadow run: replay recent real events (already judged by
// Gemini) through the detector and answer "if gate mode had been on, what
// would we have skipped, and would any of it have been a real event?"
//   npx tsx worker/tools/detector-shadow.ts [limit=150]
// Writes testdata/detector-out/shadow.md and saves snapshots of potential
// misses (detector would skip, Gemini said verified=true) for eyeballing.

try {
  process.loadEnvFile(".env");
} catch {
  // optional
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("missing Supabase env");
  process.exit(1);
}
const supabase = createClient(url, key, { auth: { persistSession: false } });
const LIMIT = Number(process.argv[2] ?? 150);
const OUT_DIR = "testdata/detector-out";

interface Row {
  event_id: string;
  event_type: string;
  occurred_at: string;
  media: { snapshot_path: string | null };
  ai: AiResult | null;
  raw: { eventType?: string } | null;
  cameras: { name: string } | null;
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const { data, error } = await supabase
    .from("events")
    .select("event_id, event_type, occurred_at, media, ai, raw, cameras(name)")
    .not("media->>snapshot_path", "is", null)
    .not("ai->>processed_at", "is", null)
    .not("ai->>model", "is", null)
    .order("occurred_at", { ascending: false })
    .limit(LIMIT * 2);
  if (error) throw new Error(error.message);
  // Fresh Gemini verdicts only — inherited/skipped rows carry no new signal.
  const rows = ((data ?? []) as unknown as Row[])
    .filter((r) => r.ai?.model && !r.ai.model.endsWith("+inherit") && r.ai.model !== "detector-gate")
    .slice(0, LIMIT);
  console.log(`detector-shadow: ${rows.length} real events, model=${MODEL_PATH}\n`);

  let n = 0, failed = 0, totalMs = 0;
  let skipFalse = 0, skipTrue = 0, sendFalse = 0, sendTrue = 0, notGated = 0;
  const misses: string[] = [];
  const lines: string[] = [];
  for (const r of rows) {
    const path = r.media.snapshot_path!;
    const { data: blob, error: dlErr } = await supabase.storage.from("snapshots").download(path);
    if (dlErr || !blob) {
      console.log(`⚠️  ${r.event_id} snapshot download failed`);
      continue;
    }
    const buf = Buffer.from(await blob.arrayBuffer());
    const run = await detectObjects(buf);
    if (!run) {
      failed += 1;
      console.log(`⚠️  ${r.event_id} detector failed (${detectorDisabledReason() ?? "timeout"})`);
      continue;
    }
    n += 1;
    totalMs += run.ms;
    const gate = decideGate({
      mode: "gate",
      eventType: r.event_type,
      rawEventType: r.raw?.eventType ?? null,
      detections: run.detections,
    });
    const gemVerified = r.ai?.verified === true;
    const cam = r.cameras?.name ?? "?";
    const when = new Date(r.occurred_at).toLocaleString("th-TH", { timeZone: "Asia/Bangkok" });
    const summary = summarizeLabels(run.detections);
    let tag: string;
    if (!gate.wouldSkip && gate.relevant.length === 0) {
      notGated += 1;
      tag = "always";
    } else if (gate.action === "skip") {
      if (gemVerified) {
        skipTrue += 1;
        tag = "❌ MISS";
        const file = `miss_${r.event_id.slice(0, 8)}.jpg`;
        writeFileSync(join(OUT_DIR, file), buf);
        misses.push(`- ${file} | ${cam} | ${when} | Gemini: [${r.ai?.severity}] ${r.ai?.description_th}`);
      } else {
        skipFalse += 1;
        tag = "✅ saved";
      }
    } else if (gemVerified) {
      sendTrue += 1;
      tag = "send (จริง)";
    } else {
      sendFalse += 1;
      tag = "send (หลอก)";
    }
    console.log(
      `${tag.padEnd(12)} ${cam.padEnd(14)} ${r.event_type.padEnd(16)} ${String(run.ms).padStart(4)}ms det=${summary.padEnd(28)} gemini=${gemVerified ? "จริง" : "หลอก"}[${r.ai?.severity}] ${(r.ai?.description_th ?? "").slice(0, 60)}`,
    );
    lines.push(`| ${tag} | ${cam} | ${when} | ${r.event_type} | ${summary} | ${gemVerified ? "จริง" : "หลอก"} [${r.ai?.severity}] | ${(r.ai?.description_th ?? "").slice(0, 80)} |`);
  }

  const gated = skipFalse + skipTrue + sendFalse + sendTrue;
  const savedPct = gated ? Math.round(((skipFalse + skipTrue) / gated) * 100) : 0;
  const summaryLines = [
    `events วิเคราะห์ได้ ${n} (detector พัง ${failed}), เวลาเฉลี่ย ${n ? Math.round(totalMs / n) : 0} ms`,
    `ประเภทที่ส่ง Gemini เสมอ (patrol/offline): ${notGated}`,
    `ประเภทคน/รถ ${gated} ภาพ → gate จะข้าม ${skipFalse + skipTrue} (${savedPct}% ประหยัด)`,
    `  ข้ามแล้วถูก (Gemini ก็ว่าหลอก): ${skipFalse}`,
    `  ข้ามแล้วอาจพลาด (Gemini ว่าจริง): ${skipTrue}  ← ดูรูป miss_*.jpg ว่าจริงไหม`,
    `  ส่งต่อ: จริง ${sendTrue} / หลอก ${sendFalse}`,
  ];
  console.log("\n" + summaryLines.join("\n"));
  if (misses.length) console.log("\nอาจพลาด:\n" + misses.join("\n"));
  writeFileSync(
    join(OUT_DIR, "shadow.md"),
    [
      `# detector-shadow ${new Date().toISOString()}`,
      "",
      ...summaryLines,
      "",
      ...(misses.length ? ["## อาจพลาด", ...misses, ""] : []),
      "| gate | camera | when | type | detector | gemini | description |",
      "|---|---|---|---|---|---|---|",
      ...lines,
    ].join("\n"),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
