import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { detectObjects, detectorDisabledReason, loadDetectorNow } from "../detector";
import { decideGate, type ObjectDetection } from "../../lib/detector-core";
import { sceneSignature, triageScore } from "../../lib/triage";
import type { AiResult } from "../../lib/types";

// ADR-016 acceptance test: replay real events under a daily VLM budget and
// answer one question — would every warning/critical event still have been
// analyzed? Compares triage order against today's behaviour (first come,
// first served). No Gemini calls: verdicts already stored on the events.
//
//   npx tsx worker/tools/triage-sim.ts [budget=500] [limit=400]
//
// Detector output is cached in testdata/triage-cache.json so re-runs while
// tuning weights take seconds instead of minutes.

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
const BUDGET = Number(process.argv[2] ?? 500);
const LIMIT = Number(process.argv[3] ?? 400);
const CACHE = "testdata/triage-cache.json";

interface Row {
  event_id: string;
  event_type: string;
  occurred_at: string;
  camera_id: string | null;
  media: { snapshot_path: string | null };
  ai: AiResult | null;
  raw: { eventType?: string } | null;
  cameras: { name: string; camera_profiles: { name_th: string } | null } | null;
  sites: { rules: { strict_hours?: { start: string; end: string } } | null } | null;
}

interface Cached {
  detections: ObjectDetection[] | null;
}

function loadCache(): Record<string, Cached> {
  try {
    return JSON.parse(readFileSync(CACHE, "utf8")) as Record<string, Cached>;
  } catch {
    return {};
  }
}

function hourBangkok(iso: string): number {
  return Number(new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Bangkok", hour: "2-digit", hour12: false }));
}

function inStrict(iso: string, sh?: { start: string; end: string } | null): boolean {
  if (!sh) return false;
  const hhmm = new Date(iso).toLocaleTimeString("en-GB", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit" });
  return sh.start <= sh.end ? hhmm >= sh.start && hhmm < sh.end : hhmm >= sh.start || hhmm < sh.end;
}

async function main(): Promise<void> {
  mkdirSync("testdata", { recursive: true });
  const cache = loadCache();
  const { data, error } = await supabase
    .from("events")
    .select(
      "event_id, event_type, occurred_at, camera_id, media, ai, raw, cameras(name, camera_profiles(name_th)), sites(rules)",
    )
    .not("media->>snapshot_path", "is", null)
    .not("ai->>processed_at", "is", null)
    .order("occurred_at", { ascending: false })
    .limit(LIMIT * 3);
  if (error) throw new Error(error.message);
  // Only events carrying a real VLM verdict give us ground truth to score against.
  const rows = ((data ?? []) as unknown as Row[])
    .filter((r) => r.ai?.model && !r.ai.model.endsWith("+inherit") && r.ai.model !== "detector-gate")
    .slice(0, LIMIT)
    .reverse();
  if (rows.length === 0) {
    console.error("no events with stored verdicts");
    process.exit(1);
  }

  const needDetector = rows.some((r) => !(r.event_id in cache));
  if (needDetector && !(await loadDetectorNow())) {
    console.error(`detector load failed: ${detectorDisabledReason()}`);
    process.exit(1);
  }

  // ---- pass 1: detector output per event (cached) --------------------------
  let fresh = 0;
  for (const r of rows) {
    if (r.event_id in cache) continue;
    const { data: blob } = await supabase.storage.from("snapshots").download(r.media.snapshot_path!);
    if (!blob) {
      cache[r.event_id] = { detections: null };
      continue;
    }
    const run = await detectObjects(Buffer.from(await blob.arrayBuffer()));
    cache[r.event_id] = { detections: run ? run.detections : null };
    fresh += 1;
    if (fresh % 25 === 0) {
      writeFileSync(CACHE, JSON.stringify(cache));
      console.log(`  ...ตรวจภาพแล้ว ${fresh} ใบ`);
    }
  }
  writeFileSync(CACHE, JSON.stringify(cache));

  // ---- pass 2: score every event in chronological order --------------------
  const recentSigs = new Map<string, string[]>();
  const lastAnalyzedAt = new Map<string, number>();
  interface Scored extends Row {
    score: number;
    reasons: string[];
    gateSkip: boolean;
    urgent: boolean;
  }
  const scored: Scored[] = [];
  for (const r of rows) {
    const cam = r.camera_id ?? r.cameras?.name ?? "?";
    const dets = cache[r.event_id]?.detections ?? null;
    const at = new Date(r.occurred_at).getTime();
    const gate = decideGate({
      mode: "gate",
      eventType: r.event_type,
      rawEventType: r.raw?.eventType ?? null,
      detections: dets,
    });
    const { score, reasons } = triageScore({
      eventType: r.event_type,
      rawEventType: r.raw?.eventType ?? null,
      detections: dets,
      nowHourBangkok: hourBangkok(r.occurred_at),
      inStrictHours: inStrict(r.occurred_at, r.sites?.rules?.strict_hours),
      profileName: r.cameras?.camera_profiles?.name_th ?? null,
      recentSignatures: recentSigs.get(cam) ?? [],
      minutesSinceCameraLastAnalyzed: lastAnalyzedAt.has(cam)
        ? (at - lastAnalyzedAt.get(cam)!) / 60_000
        : 0,
    });
    scored.push({
      ...r,
      score,
      reasons,
      gateSkip: gate.action === "skip",
      urgent: r.ai?.verified === true && (r.ai.severity === "warning" || r.ai.severity === "critical"),
    });
    if (dets) {
      const arr = recentSigs.get(cam) ?? [];
      arr.push(sceneSignature(dets));
      recentSigs.set(cam, arr.slice(-30));
    }
    lastAnalyzedAt.set(cam, at);
  }

  // ---- pass 3: spend the budget two ways -----------------------------------
  const urgentTotal = scored.filter((e) => e.urgent).length;
  const spendable = scored.filter((e) => !e.gateSkip);
  const gateSaved = scored.length - spendable.length;

  const fifo = spendable.slice(0, BUDGET);
  const byScore = [...spendable].sort((a, b) => b.score - a.score || a.occurred_at.localeCompare(b.occurred_at)).slice(0, BUDGET);
  const missedBy = (kept: Scored[]) => {
    const ids = new Set(kept.map((e) => e.event_id));
    return scored.filter((e) => e.urgent && !ids.has(e.event_id));
  };
  const fifoMissed = missedBy(fifo);
  const triageMissed = missedBy(byScore);
  // Anything the ADR-015 gate dropped counts against triage too — it is part
  // of the same pipeline, and a warning dropped there is just as lost.
  const gateMissedUrgent = scored.filter((e) => e.urgent && e.gateSkip);

  const pct = (n: number, d: number) => (d === 0 ? "100" : ((n / d) * 100).toFixed(1));
  console.log(`\n=== จำลองงบ ${BUDGET} ครั้ง กับ ${scored.length} event จริง ===`);
  console.log(`เหตุระดับ warning/critical ทั้งหมดในชุดนี้: ${urgentTotal}`);
  console.log(`gate (ADR-015) กรองทิ้งก่อนถึงคิว: ${gateSaved} ใบ — ในนั้นเป็นเหตุสำคัญ ${gateMissedUrgent.length} ใบ`);
  console.log(`เหลือเข้าคิว ${spendable.length} ใบ, งบพอ ${Math.min(BUDGET, spendable.length)} ใบ\n`);
  console.log(`แบบเดิม (มาก่อนได้ก่อน) : ได้ตรวจเหตุสำคัญ ${urgentTotal - fifoMissed.length}/${urgentTotal} (${pct(urgentTotal - fifoMissed.length, urgentTotal)}%)`);
  console.log(`แบบพยาบาลคัดกรอง        : ได้ตรวจเหตุสำคัญ ${urgentTotal - triageMissed.length}/${urgentTotal} (${pct(urgentTotal - triageMissed.length, urgentTotal)}%)`);

  if (triageMissed.length) {
    console.log(`\n❌ เหตุสำคัญที่ยังหลุดในแบบพยาบาล (${triageMissed.length}):`);
    for (const e of triageMissed.slice(0, 15)) {
      console.log(
        `  คะแนน ${e.score} | ${new Date(e.occurred_at).toLocaleString("th-TH", { timeZone: "Asia/Bangkok" })} | ${e.cameras?.name} | [${e.ai?.severity}] ${(e.ai?.description_th ?? "").slice(0, 70)}`,
      );
      console.log(`     เหตุผลคะแนน: ${e.reasons.join(", ") || "-"}${e.gateSkip ? " | ถูก gate กรอง" : ""}`);
    }
  }

  // Where the cut line falls, so the weights can be judged by eye.
  const cut = byScore.length ? byScore[byScore.length - 1].score : 0;
  const urgentScores = scored.filter((e) => e.urgent).map((e) => e.score).sort((a, b) => a - b);
  console.log(`\nคะแนนตัดคิวที่งบ ${BUDGET}: ${cut}`);
  if (urgentScores.length) {
    console.log(`คะแนนของเหตุสำคัญ: ต่ำสุด ${urgentScores[0]}, กลาง ${urgentScores[Math.floor(urgentScores.length / 2)]}, สูงสุด ${urgentScores[urgentScores.length - 1]}`);
  }
  const dist = new Map<number, number>();
  for (const e of spendable) {
    const b = Math.floor(e.score / 10) * 10;
    dist.set(b, (dist.get(b) ?? 0) + 1);
  }
  console.log("\nการกระจายคะแนน (ทุกใบที่เข้าคิว):");
  for (const [b, n] of [...dist.entries()].sort((a, b) => b[0] - a[0])) {
    console.log(`  ${String(b).padStart(3)}-${String(b + 9).padStart(3)} ${"█".repeat(Math.ceil(n / 3))} ${n}`);
  }
  const verdict = triageMissed.length === 0 && gateMissedUrgent.length === 0;
  console.log(`\n${verdict ? "✅ ผ่านเกณฑ์ ADR-016 (เหตุสำคัญได้ตรวจครบ 100%)" : "❌ ยังไม่ผ่านเกณฑ์ ADR-016 — ห้ามเปิดใช้"}`);
  const outDir = "testdata/detector-out";
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, "triage-sim.md"),
    [
      `# triage-sim (งบ ${BUDGET}, ${scored.length} events)`,
      "",
      `- เหตุสำคัญทั้งหมด: ${urgentTotal}`,
      `- แบบเดิม: ${urgentTotal - fifoMissed.length}/${urgentTotal}`,
      `- แบบพยาบาล: ${urgentTotal - triageMissed.length}/${urgentTotal}`,
      `- gate กรองทิ้ง: ${gateSaved} (เป็นเหตุสำคัญ ${gateMissedUrgent.length})`,
      `- คะแนนตัดคิว: ${cut}`,
      "",
      "| คะแนน | เวลา | กล้อง | ผล VLM | เหตุผล |",
      "|---|---|---|---|---|",
      ...[...scored]
        .sort((a, b) => b.score - a.score)
        .slice(0, 60)
        .map(
          (e) =>
            `| ${e.score} | ${new Date(e.occurred_at).toLocaleString("th-TH", { timeZone: "Asia/Bangkok" })} | ${e.cameras?.name ?? "?"} | ${e.ai?.verified ? "จริง" : "หลอก"} [${e.ai?.severity}] | ${e.reasons.join(", ")} |`,
        ),
    ].join("\n"),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
