import { createClient } from "@supabase/supabase-js";

// Drop a stale analysis backlog (e.g. after a daily-quota outage). Analysing
// yesterday's frames spends today's budget on pictures nobody can act on, and
// the alert path now suppresses anything that old anyway.
//
//   npx tsx worker/tools/clear-backlog.ts            # dry run, shows what would go
//   npx tsx worker/tools/clear-backlog.ts --apply    # do it
//   npx tsx worker/tools/clear-backlog.ts --apply 120  # only older than 120 min
//
// Snapshots are untouched: the events stay visible in the dashboard with their
// image, and "วิเคราะห์อีกครั้ง" can still be pressed on any of them.

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

const APPLY = process.argv.includes("--apply");
const OLDER_THAN_MIN = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 30);
// Marker so these rows are never mistaken for "the VLM tried and failed".
const SKIPPED_MODEL = "skipped-stale";

const th = (d: string) => new Date(d).toLocaleString("th-TH", { timeZone: "Asia/Bangkok" });

async function main(): Promise<void> {
  const cutoff = new Date(Date.now() - OLDER_THAN_MIN * 60_000).toISOString();
  const { data, error } = await supabase
    .from("events")
    .select("event_id, occurred_at, event_type, cameras(name)")
    .is("ai->>processed_at", null)
    .lt("occurred_at", cutoff)
    .order("occurred_at", { ascending: true })
    .limit(5000);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as unknown as {
    event_id: string;
    occurred_at: string;
    event_type: string;
    cameras: { name: string } | null;
  }[];

  if (rows.length === 0) {
    console.log(`ไม่มี event ค้างที่เก่ากว่า ${OLDER_THAN_MIN} นาที — คิวสะอาดอยู่แล้ว`);
    return;
  }

  const perCam = new Map<string, number>();
  for (const r of rows) perCam.set(r.cameras?.name ?? "?", (perCam.get(r.cameras?.name ?? "?") ?? 0) + 1);
  console.log(`event ค้างที่เก่ากว่า ${OLDER_THAN_MIN} นาที: ${rows.length} ใบ`);
  console.log(`  เก่าสุด ${th(rows[0].occurred_at)}`);
  console.log(`  ใหม่สุด ${th(rows[rows.length - 1].occurred_at)}`);
  for (const [cam, n] of [...perCam.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cam.padEnd(26)} ${n}`);
  }

  if (!APPLY) {
    console.log("\n(ยังไม่ได้ทำอะไร — ใส่ --apply เพื่อล้างจริง)");
    return;
  }

  // Stamping processed_at is enough: the worker acks any queued message whose
  // event is already settled, so pgmq drains itself without a single VLM call.
  const ai = {
    verified: null,
    severity: null,
    description_th: `ไม่ได้วิเคราะห์ — ภาพค้างคิวจากช่วงโควตาหมด และเก่าเกิน ${OLDER_THAN_MIN} นาทีแล้ว (ภาพยังดูย้อนหลังได้)`,
    model: SKIPPED_MODEL,
    processed_at: new Date().toISOString(),
  };
  let done = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const batch = rows.slice(i, i + 200).map((r) => r.event_id);
    const { error: upErr } = await supabase.from("events").update({ ai }).in("event_id", batch);
    if (upErr) throw new Error(`update failed: ${upErr.message}`);
    done += batch.length;
    console.log(`  ...ล้างแล้ว ${done}/${rows.length}`);
  }
  console.log(`\n✅ ล้างคิวเก่า ${done} ใบ — worker จะเคลียร์คิวที่เหลือเองโดยไม่เรียก AI`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
