import { createClient } from "@supabase/supabase-js";
import type { AiResult } from "../../lib/types";

// Where the daily VLM budget actually goes: events per hour, per camera, and
// how many of them cost a real Gemini call. Drives cooldown tuning decisions.
//   npx tsx worker/tools/event-stats.ts [days=1]

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
const DAYS = Number(process.argv[2] ?? 1);
// Matches the listener's own definition (NVR_BUSY_START/END).
const BUSY_START = 8;
const BUSY_END = 19;

interface Row {
  occurred_at: string;
  event_type: string;
  ai: AiResult | null;
  cameras: { name: string } | null;
}

function hourBangkok(iso: string): number {
  return Number(
    new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Bangkok", hour: "2-digit", hour12: false }),
  );
}

// Did this event cost a Gemini call?
const FREE_MODELS = new Set(["detector-gate", "skipped-backlog", "skipped-stale"]);
function costsCall(ai: AiResult | null): boolean {
  const m = ai?.model;
  return !!m && !m.endsWith("+inherit") && !FREE_MODELS.has(m);
}

async function main(): Promise<void> {
  const since = new Date(Date.now() - DAYS * 24 * 3600_000).toISOString();
  const { data, error } = await supabase
    .from("events")
    .select("occurred_at, event_type, ai, cameras(name)")
    .gte("occurred_at", since)
    .order("occurred_at", { ascending: true })
    .limit(5000);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as unknown as Row[];
  if (rows.length === 0) {
    console.log("ไม่มี event ในช่วงนี้");
    return;
  }

  const perHour = new Map<number, { events: number; calls: number }>();
  const perCam = new Map<string, { day: number; night: number; calls: number }>();
  let dayEvents = 0, nightEvents = 0, dayCalls = 0, nightCalls = 0;
  for (const r of rows) {
    const h = hourBangkok(r.occurred_at);
    const isDay = h >= BUSY_START && h < BUSY_END;
    const call = costsCall(r.ai);
    const cam = r.cameras?.name ?? "ไม่ระบุ";
    const hs = perHour.get(h) ?? { events: 0, calls: 0 };
    hs.events += 1;
    if (call) hs.calls += 1;
    perHour.set(h, hs);
    const cs = perCam.get(cam) ?? { day: 0, night: 0, calls: 0 };
    if (isDay) cs.day += 1; else cs.night += 1;
    if (call) cs.calls += 1;
    perCam.set(cam, cs);
    if (isDay) { dayEvents += 1; if (call) dayCalls += 1; }
    else { nightEvents += 1; if (call) nightCalls += 1; }
  }

  const total = rows.length;
  const pct = (n: number) => Math.round((n / total) * 100);
  console.log(`ช่วง ${DAYS} วันล่าสุด — event ทั้งหมด ${total} (เฉลี่ย ${Math.round(total / DAYS)}/วัน)\n`);
  console.log(`กลางวัน ${String(BUSY_START).padStart(2, "0")}:00-${BUSY_END}:00  ${String(dayEvents).padStart(4)} event (${pct(dayEvents)}%)  → เรียก Gemini ${dayCalls}`);
  console.log(`กลางคืน ${BUSY_END}:00-${String(BUSY_START).padStart(2, "0")}:00  ${String(nightEvents).padStart(4)} event (${pct(nightEvents)}%)  → เรียก Gemini ${nightCalls}\n`);

  console.log("ต่อชั่วโมง (เวลาไทย) — ▓ = event, ตัวเลขหลัง = ที่เรียก Gemini จริง");
  for (let h = 0; h < 24; h++) {
    const s = perHour.get(h) ?? { events: 0, calls: 0 };
    const perDay = s.events / DAYS;
    const mark = h >= BUSY_START && h < BUSY_END ? "☀" : "🌙";
    console.log(`  ${mark} ${String(h).padStart(2, "0")}:00 ${"▓".repeat(Math.round(perDay / 2))} ${Math.round(perDay)}  (Gemini ${Math.round(s.calls / DAYS)})`);
  }

  // Why a daytime event often costs nothing: the busy-scene inherit shortcut.
  const dayKinds = new Map<string, number>();
  const nightKinds = new Map<string, number>();
  for (const r of rows) {
    const h = hourBangkok(r.occurred_at);
    const slot = h >= BUSY_START && h < BUSY_END ? dayKinds : nightKinds;
    const m = r.ai?.model;
    const k = !r.ai?.processed_at
      ? "ยังไม่ประมวลผล"
      : m === null
        ? "ล้มเหลว/โควตาหมด"
        : String(m).endsWith("+inherit")
          ? "สืบทอดคำตัดสินเดิม (ไม่เสียโควตา)"
          : m === "detector-gate"
            ? "YOLO กรอง (ไม่เสียโควตา)"
            : m === "skipped-backlog" || m === "skipped-stale"
              ? "ข้ามภาพเก่า (ไม่เสียโควตา)"
              : "เรียก Gemini";
    slot.set(k, (slot.get(k) ?? 0) + 1);
  }
  console.log("\nแยกตามสิ่งที่เกิดขึ้นกับ event:");
  for (const [label, m] of [["กลางวัน", dayKinds], ["กลางคืน", nightKinds]] as const) {
    console.log(`  ${label}:`);
    for (const [k, v] of [...m.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`     ${k.padEnd(36)} ${String(v).padStart(4)}`);
    }
  }

  // Cost is driven by how much a camera *moves*, not by how many cameras there
  // are: measured 2026-08-19, the parking camera costs ~7x an indoor one.
  // 0.0135 THB/call = 2,738-token prompt + 2 images + reply at flash-lite rates.
  const THB_PER_CALL = Number(process.env.THB_PER_VLM_CALL ?? 0.0135);
  console.log("\nต่อกล้อง (ต้นทุน AI ประมาณการ):");
  let monthTotal = 0;
  for (const [cam, v] of [...perCam.entries()].sort((a, b) => b[1].calls - a[1].calls)) {
    const t = v.day + v.night;
    const perDay = (v.calls / DAYS) * THB_PER_CALL;
    const perMonth = perDay * 30;
    monthTotal += perMonth;
    console.log(
      `  ${cam.padEnd(26)} event ${String(t).padStart(4)} (${pct(t)}%) | กลางวัน ${String(v.day).padStart(4)} กลางคืน ${String(v.night).padStart(4)} | เรียก AI ${String(v.calls).padStart(4)} → ${perMonth.toFixed(0).padStart(4)} บาท/เดือน`,
    );
  }
  console.log(`  ${"รวมทั้งไซต์".padEnd(26)} ${monthTotal.toFixed(0)} บาท/เดือน (${(monthTotal / Math.max(1, perCam.size)).toFixed(0)} บาท/กล้อง โดยเฉลี่ย)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
