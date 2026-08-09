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
      <p style={{ color: "#9E9E9E", fontSize: "0.85rem" }}>
        รายงานสรุปภาษาไทยพร้อม PDF ส่งเข้า LINE อัตโนมัติทุก 06:00 จะเปิดใช้ในเฟสถัดไป
      </p>
    </main>
  );
}
