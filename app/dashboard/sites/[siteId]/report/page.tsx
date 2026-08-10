import Link from "next/link";
import { notFound } from "next/navigation";
import { getSessionClient } from "@/lib/supabase-auth";
import { TYPE_TH } from "@/lib/labels";
import type { EventType } from "@/lib/types";

export const dynamic = "force-dynamic";

// Daily stats view — the in-web half of M5. Claude-written narrative, PDF, and
// LINE delivery arrive when M2/M5 proper land; the numbers are useful today.

interface EventLite {
  event_type: EventType;
  occurred_at: string;
  camera_id: string | null;
  ai: { verified: boolean | null } | null;
  alerts: { feedback: string | null }[];
}

function bangkokDayStart(daysAgo: number): Date {
  const now = new Date();
  const bangkok = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
  bangkok.setDate(bangkok.getDate() - daysAgo);
  bangkok.setHours(0, 0, 0, 0);
  const offsetMs = now.getTime() - new Date(now.toLocaleString("en-US", { timeZone: "Asia/Bangkok" })).getTime();
  return new Date(bangkok.getTime() + offsetMs);
}

function summarize(events: EventLite[]) {
  const byType = new Map<string, number>();
  let aiReal = 0;
  let aiFalse = 0;
  let userFalse = 0;
  let offline = 0;
  for (const ev of events) {
    byType.set(ev.event_type, (byType.get(ev.event_type) ?? 0) + 1);
    if (ev.ai?.verified === true) aiReal += 1;
    if (ev.ai?.verified === false) aiFalse += 1;
    if (ev.alerts?.some((a) => a.feedback === "false_alarm")) userFalse += 1;
    if (ev.event_type === "camera_offline") offline += 1;
  }
  return { total: events.length, byType, aiReal, aiFalse, userFalse, offline };
}

const statCard = {
  background: "#fff",
  borderRadius: 16,
  padding: "0.9rem 1.1rem",
  minWidth: 130,
  flex: 1,
} as const;

function StatBlock({ title, events }: { title: string; events: EventLite[] }) {
  const s = summarize(events);
  return (
    <section style={{ marginBottom: "1.4rem" }}>
      <h2 style={{ margin: "0 0 0.6rem", fontSize: "1.1rem" }}>{title}</h2>
      <div style={{ display: "flex", gap: "0.7rem", flexWrap: "wrap", marginBottom: "0.8rem" }}>
        <div style={statCard}>
          <div style={{ fontSize: "0.8rem", color: "#9E9E9E" }}>เหตุการณ์ทั้งหมด</div>
          <div style={{ fontSize: "1.6rem", fontWeight: 600 }}>{s.total}</div>
        </div>
        <div style={statCard}>
          <div style={{ fontSize: "0.8rem", color: "#9E9E9E" }}>AI ยืนยันเหตุจริง</div>
          <div style={{ fontSize: "1.6rem", fontWeight: 600, color: "#009E4A" }}>{s.aiReal}</div>
        </div>
        <div style={statCard}>
          <div style={{ fontSize: "0.8rem", color: "#9E9E9E" }}>AI กรองว่าหลอก</div>
          <div style={{ fontSize: "1.6rem", fontWeight: 600, color: "#9E9E9E" }}>{s.aiFalse}</div>
        </div>
        <div style={statCard}>
          <div style={{ fontSize: "0.8rem", color: "#9E9E9E" }}>กล้องขาดการติดต่อ</div>
          <div style={{ fontSize: "1.6rem", fontWeight: 600, color: s.offline > 0 ? "#C0392B" : "#1D1D1F" }}>{s.offline}</div>
        </div>
      </div>
      {s.total > 0 && (
        <div style={{ background: "#fff", borderRadius: 16, padding: "0.8rem 1.1rem" }}>
          {[...s.byType.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([type, count]) => (
              <div key={type} style={{ display: "flex", justifyContent: "space-between", padding: "0.3rem 0", borderBottom: "1px solid #f0f1f3", fontSize: "0.95rem" }}>
                <span>{TYPE_TH[type as EventType] ?? type}</span>
                <strong>{count}</strong>
              </div>
            ))}
        </div>
      )}
    </section>
  );
}

// Which camera cries wolf? 7-day false-alarm rate per camera — this is the
// ADR-008 feedback loop made visible, so we know which camera to tune.
async function CameraQuality({ siteId }: { siteId: string }) {
  const supabase = await getSessionClient();
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const { data } = await supabase
    .from("events")
    .select("camera_id, ai, alerts(feedback), cameras(name)")
    .eq("site_id", siteId)
    .gte("occurred_at", since)
    .not("camera_id", "is", null)
    .limit(2000);

  const byCamera = new Map<
    string,
    { name: string; total: number; aiFalse: number; userFalse: number }
  >();
  for (const row of data ?? []) {
    const r = row as unknown as {
      camera_id: string;
      ai: { verified: boolean | null } | null;
      alerts: { feedback: string | null }[];
      cameras: { name: string } | null;
    };
    const entry = byCamera.get(r.camera_id) ?? {
      name: r.cameras?.name ?? "ไม่ทราบชื่อ",
      total: 0,
      aiFalse: 0,
      userFalse: 0,
    };
    entry.total += 1;
    if (r.ai?.verified === false) entry.aiFalse += 1;
    if (r.alerts?.some((a) => a.feedback === "false_alarm")) entry.userFalse += 1;
    byCamera.set(r.camera_id, entry);
  }

  const rows = [...byCamera.values()].sort((a, b) => b.total - a.total);
  if (rows.length === 0) return null;

  return (
    <section style={{ marginBottom: "1.4rem" }}>
      <h2 style={{ margin: "0 0 0.6rem", fontSize: "1.1rem" }}>คุณภาพรายกล้อง (7 วันล่าสุด)</h2>
      <div style={{ background: "#fff", borderRadius: 16, padding: "0.8rem 1.1rem" }}>
        <div style={{ display: "flex", fontSize: "0.8rem", color: "#9E9E9E", padding: "0.2rem 0", borderBottom: "1px solid #f0f1f3" }}>
          <span style={{ flex: 1 }}>กล้อง</span>
          <span style={{ width: 70, textAlign: "right" }}>event</span>
          <span style={{ width: 110, textAlign: "right" }}>AI กรองหลอก</span>
          <span style={{ width: 110, textAlign: "right" }}>คนกดแจ้งเท็จ</span>
        </div>
        {rows.map((r) => {
          const falsePct = r.total === 0 ? 0 : Math.round(((r.aiFalse + r.userFalse) / r.total) * 100);
          return (
            <div key={r.name} style={{ display: "flex", fontSize: "0.92rem", padding: "0.35rem 0", borderBottom: "1px solid #f0f1f3", alignItems: "baseline" }}>
              <span style={{ flex: 1 }}>
                {r.name}
                {falsePct >= 30 && (
                  <span style={{ marginLeft: 6, fontSize: "0.75rem", color: "#C0392B" }}>← ควรจูน</span>
                )}
              </span>
              <span style={{ width: 70, textAlign: "right" }}>{r.total}</span>
              <span style={{ width: 110, textAlign: "right" }}>{r.aiFalse}</span>
              <span style={{ width: 110, textAlign: "right" }}>{r.userFalse}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export default async function SiteReportPage({
  params,
}: {
  params: Promise<{ siteId: string }>;
}) {
  const { siteId } = await params;
  const supabase = await getSessionClient();

  const { data: site } = await supabase
    .from("sites")
    .select("id, name")
    .eq("id", siteId)
    .maybeSingle();
  if (!site) notFound();

  const todayStart = bangkokDayStart(0);
  const yesterdayStart = bangkokDayStart(1);

  const { data } = await supabase
    .from("events")
    .select("event_type, occurred_at, camera_id, ai, alerts(feedback)")
    .eq("site_id", siteId)
    .gte("occurred_at", yesterdayStart.toISOString())
    .order("occurred_at", { ascending: false })
    .limit(1000);
  const all = (data ?? []) as unknown as EventLite[];

  const today = all.filter((e) => new Date(e.occurred_at) >= todayStart);
  const yesterday = all.filter((e) => new Date(e.occurred_at) < todayStart);

  return (
    <main>
      <div style={{ display: "flex", alignItems: "baseline", gap: "0.75rem", marginBottom: "1rem" }}>
        <h1 style={{ margin: 0, fontSize: "1.3rem" }}>📊 รายงาน — {site.name}</h1>
        <Link href={`/dashboard/sites/${siteId}`} style={{ fontSize: "0.9rem", color: "#9E9E9E", marginLeft: "auto" }}>
          ← กลับ
        </Link>
      </div>
      <StatBlock title="วันนี้" events={today} />
      <StatBlock title="เมื่อวาน" events={yesterday} />
      <CameraQuality siteId={siteId} />
      <p style={{ color: "#9E9E9E", fontSize: "0.85rem" }}>
        รายงานสรุปภาษาไทยพร้อม PDF ส่งเข้า LINE อัตโนมัติทุก 06:00 จะเปิดใช้ในเฟสถัดไป
      </p>
    </main>
  );
}
