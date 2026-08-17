import Link from "next/link";
import { notFound } from "next/navigation";
import { getSessionClient } from "@/lib/supabase-auth";
import { ALARM_TYPES, formatThaiTime, TYPE_TH } from "@/lib/labels";
import type { EventType } from "@/lib/types";
import { reanalyzeEvent, submitEventFeedback } from "./actions";
import { AutoRefresh } from "./auto-refresh";

export const dynamic = "force-dynamic";

interface EventRow {
  event_id: string;
  event_type: EventType;
  occurred_at: string;
  detection: { zone: string | null; plate: string | null } | null;
  media: { snapshot_path: string | null } | null;
  ai: {
    verified: boolean | null;
    severity: string | null;
    description_th: string | null;
    processed_at: string | null;
  } | null;
  cameras: { name: string } | null;
  alerts: { feedback: string | null }[];
}

const DAY_CHOICES = [
  { value: "1", label: "วันนี้" },
  { value: "7", label: "7 วันล่าสุด" },
  { value: "30", label: "30 วันล่าสุด" },
];

export default async function SiteEventsPage({
  params,
  searchParams,
}: {
  params: Promise<{ siteId: string }>;
  searchParams: Promise<{ days?: string; camera?: string; type?: string; view?: string }>;
}) {
  const { siteId } = await params;
  const { days = "1", camera = "", type = "", view = "" } = await searchParams;

  const supabase = await getSessionClient();

  const { data: site } = await supabase
    .from("sites")
    .select("id, name")
    .eq("id", siteId)
    .maybeSingle();
  if (!site) notFound();

  const { data: cameraRows } = await supabase
    .from("cameras")
    .select("id, name")
    .eq("site_id", siteId)
    .order("name");
  const cameras = cameraRows ?? [];

  const since = new Date();
  since.setDate(since.getDate() - (Number(days) || 1));
  since.setHours(0, 0, 0, 0);

  let query = supabase
    .from("events")
    .select(
      "event_id, event_type, occurred_at, detection, media, ai, cameras(name), alerts(feedback)",
    )
    .eq("site_id", siteId)
    .gte("occurred_at", since.toISOString())
    .order("occurred_at", { ascending: false })
    .limit(60);
  if (camera) query = query.eq("camera_id", camera);
  if (type) query = query.eq("event_type", type);
  // "เฉพาะผิดปกติ": AI-verified events at warning/critical only.
  if (view === "abnormal") {
    query = query.filter("ai->>severity", "in", '("warning","critical")');
  }

  const { data } = await query;
  const events = (data ?? []) as unknown as EventRow[];
  // No inline images by design — the list stays a few KB and renders instantly;
  // each photo is fetched on demand via the snapshot route.

  return (
    <main>
      <div style={{ display: "flex", alignItems: "baseline", gap: "0.75rem", flexWrap: "wrap" }}>
        <h1 style={{ margin: 0, fontSize: "1.3rem" }}>{site.name}</h1>
        <Link
          href={`/dashboard/sites/${siteId}/settings`}
          style={{ fontSize: "0.9rem", color: "#009E4A", fontWeight: 500 }}
        >
          ⚙️ ตั้งค่าการแจ้งเตือน
        </Link>
        <Link
          href={`/dashboard/sites/${siteId}/report`}
          style={{ fontSize: "0.9rem", color: "#009E4A", fontWeight: 500 }}
        >
          📊 รายงาน
        </Link>
        <span style={{ marginLeft: "auto", display: "flex", gap: "0.9rem", alignItems: "baseline" }}>
          <AutoRefresh seconds={30} />
          <Link href="/dashboard" style={{ fontSize: "0.9rem", color: "#9E9E9E" }}>
            ← ทุกโครงการ
          </Link>
        </span>
      </div>

      <form
        method="get"
        style={{
          display: "flex",
          gap: "0.5rem",
          flexWrap: "wrap",
          margin: "0.9rem 0",
          alignItems: "center",
        }}
      >
        <select name="days" defaultValue={days} style={{ padding: "0.45rem", borderRadius: 8, border: "1px solid #ccd0d5", fontSize: "0.95rem" }}>
          {DAY_CHOICES.map((c) => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </select>
        <select name="camera" defaultValue={camera} style={{ padding: "0.45rem", borderRadius: 8, border: "1px solid #ccd0d5", fontSize: "0.95rem" }}>
          <option value="">ทุกกล้อง</option>
          {cameras.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <select name="type" defaultValue={type} style={{ padding: "0.45rem", borderRadius: 8, border: "1px solid #ccd0d5", fontSize: "0.95rem" }}>
          <option value="">ทุกประเภท</option>
          {Object.entries(TYPE_TH).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
        <select name="view" defaultValue={view} style={{ padding: "0.45rem", borderRadius: 8, border: "1px solid #ccd0d5", fontSize: "0.95rem" }}>
          <option value="">แสดงทั้งหมด</option>
          <option value="abnormal">🔴 เฉพาะผิดปกติ</option>
        </select>
        <button
          type="submit"
          style={{ padding: "0.45rem 1.1rem", borderRadius: 999, border: "none", background: "#1D1D1F", color: "#fff", fontSize: "0.95rem", fontWeight: 500, cursor: "pointer" }}
        >
          แสดง
        </button>
      </form>

      {events.length === 0 && (
        <p style={{ color: "#9E9E9E" }}>ไม่มีเหตุการณ์ในช่วงที่เลือก</p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "0.7rem" }}>
        {events.map((ev) => {
          const isAlarm = ALARM_TYPES.includes(ev.event_type);
          const feedback = ev.alerts?.[0]?.feedback ?? null;
          return (
            <div
              key={ev.event_id}
              style={{
                background: "#fff",
                border: "1px solid #e3e5e8",
                borderLeft: isAlarm ? "5px solid #E5484D" : "1px solid #e3e5e8",
                borderRadius: 16,
                padding: "0.75rem 0.9rem",
                display: "flex",
                gap: "0.9rem",
                alignItems: "flex-start",
                flexWrap: "wrap",
              }}
            >
              <div style={{ flex: 1, minWidth: 220 }}>
                <div style={{ fontWeight: 700, display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                  {TYPE_TH[ev.event_type] ?? ev.event_type}
                  {ev.ai?.verified === true && (ev.ai.severity === "warning" || ev.ai.severity === "critical") && (
                    <span style={{ fontWeight: 600, fontSize: "0.75rem", color: "#C0392B", background: "#FDECEC", borderRadius: 999, padding: "0.1rem 0.6rem" }}>
                      ผิดปกติ
                    </span>
                  )}
                  {ev.ai?.verified === true && ev.ai.severity === "info" && (
                    <span style={{ fontWeight: 600, fontSize: "0.75rem", color: "#009E4A", background: "rgba(0,222,104,0.12)", borderRadius: 999, padding: "0.1rem 0.6rem" }}>
                      ปกติ
                    </span>
                  )}
                  {ev.ai?.verified === false && (
                    <span style={{ fontWeight: 600, fontSize: "0.75rem", color: "#9E9E9E", background: "#eef0f2", borderRadius: 999, padding: "0.1rem 0.6rem" }}>
                      กรองแล้ว: แจ้งเตือนหลอก
                    </span>
                  )}
                  <span style={{ fontWeight: 400, color: "#9E9E9E", fontSize: "0.85rem" }}>
                    {ev.cameras?.name ?? "ไม่ระบุกล้อง"} · {formatThaiTime(ev.occurred_at)}
                  </span>
                  {ev.media?.snapshot_path && (
                    <a
                      href={`/dashboard/sites/${siteId}/snapshot/${ev.event_id}`}
                      target="_blank"
                      rel="noreferrer"
                      style={{ fontWeight: 500, fontSize: "0.85rem", color: "#009E4A", marginLeft: "auto" }}
                    >
                      📷 ดูภาพ
                    </a>
                  )}
                </div>
                {ev.ai?.description_th && (
                  <div style={{ marginTop: 4, color: "#1D1D1F" }}>🤖 {ev.ai.description_th}</div>
                )}
                {!ev.ai?.description_th && !ev.ai?.processed_at && ev.media?.snapshot_path && (
                  <div style={{ marginTop: 4, color: "#9E9E9E", fontSize: "0.85rem" }}>
                    ⏳ กำลังวิเคราะห์ภาพ... (รีเฟรชหน้าเพื่อดูผล)
                  </div>
                )}
                {!ev.ai?.description_th && ev.ai?.processed_at && ev.media?.snapshot_path && (
                  <form action={reanalyzeEvent} style={{ marginTop: 4 }}>
                    <input type="hidden" name="eventId" value={ev.event_id} />
                    <input type="hidden" name="siteId" value={siteId} />
                    <span style={{ color: "#9E9E9E", fontSize: "0.85rem", marginRight: 8 }}>
                      วิเคราะห์ภาพไม่สำเร็จ
                    </span>
                    <button
                      style={{ fontSize: "0.85rem", padding: "0.3rem 0.9rem", borderRadius: 999, border: "1px solid #ccd0d5", background: "#fff", cursor: "pointer" }}
                    >
                      🔄 วิเคราะห์อีกครั้ง
                    </button>
                  </form>
                )}
                {ev.ai?.verified === false && (
                  <div style={{ marginTop: 2, color: "#996", fontSize: "0.85rem" }}>
                    ระบบคาดว่าเป็นการแจ้งเตือนหลอก
                  </div>
                )}
                {ev.detection?.plate && (
                  <div style={{ marginTop: 2, fontSize: "0.9rem" }}>ทะเบียน: {ev.detection.plate}</div>
                )}
                <div style={{ marginTop: 8 }}>
                  {feedback === "false_alarm" ? (
                    <span style={{ color: "#b06000", fontSize: "0.85rem" }}>✓ บันทึกว่าแจ้งเท็จแล้ว — ขอบคุณ ระบบจะฉลาดขึ้น</span>
                  ) : feedback === "confirmed" ? (
                    <span style={{ color: "#009E4A", fontSize: "0.85rem" }}>✓ ยืนยันว่าเป็นเหตุจริงแล้ว</span>
                  ) : (
                    <form action={submitEventFeedback} style={{ display: "inline-flex", gap: "0.4rem" }}>
                      <input type="hidden" name="eventId" value={ev.event_id} />
                      <input type="hidden" name="siteId" value={siteId} />
                      <button name="feedback" value="false_alarm" style={{ fontSize: "0.85rem", padding: "0.3rem 0.9rem", borderRadius: 999, border: "1px solid #ccd0d5", background: "#fff", cursor: "pointer" }}>
                        แจ้งเท็จ
                      </button>
                      <button name="feedback" value="confirmed" style={{ fontSize: "0.85rem", padding: "0.3rem 0.9rem", borderRadius: 999, border: "1px solid #ccd0d5", background: "#fff", cursor: "pointer" }}>
                        เหตุจริง
                      </button>
                    </form>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </main>
  );
}
