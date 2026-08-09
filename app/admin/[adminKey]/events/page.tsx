import { notFound } from "next/navigation";
import { getServiceClient } from "@/lib/supabase";
import type { EventType } from "@/lib/types";

// Interim admin view (pre-M4): secret path segment instead of real auth.
// Replaced by Supabase Auth login in M4.
export const dynamic = "force-dynamic";

const TYPE_TH: Record<EventType, string> = {
  person_detected: "พบบุคคล",
  vehicle_detected: "พบยานพาหนะ",
  line_crossing: "ข้ามเส้น",
  intrusion: "บุกรุกโซนหวงห้าม",
  loitering: "เดินเตร่",
  lpr: "อ่านป้ายทะเบียน",
  camera_offline: "กล้องออฟไลน์",
  camera_online: "กล้องกลับมาออนไลน์",
  unknown: "ไม่ทราบประเภท",
};

const ALARM_TYPES: EventType[] = ["intrusion", "line_crossing", "loitering"];

interface EventRow {
  event_id: string;
  event_type: EventType;
  source_type: string;
  occurred_at: string;
  detection: { zone: string | null; plate: string | null } | null;
  ai: {
    verified: boolean | null;
    severity: string | null;
    description_th: string | null;
  } | null;
  raw: Record<string, unknown>;
  cameras: { name: string } | null;
  sites: { name: string } | null;
}

function formatThaiTime(iso: string): string {
  return new Date(iso).toLocaleString("th-TH", {
    timeZone: "Asia/Bangkok",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export default async function AdminEventsPage({
  params,
}: {
  params: Promise<{ adminKey: string }>;
}) {
  const { adminKey } = await params;
  const expected = process.env.ADMIN_DASH_KEY;
  if (!expected || adminKey !== expected) notFound();

  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("events")
    .select(
      "event_id, event_type, source_type, occurred_at, detection, ai, raw, cameras(name), sites(name)",
    )
    .order("occurred_at", { ascending: false })
    .limit(50);

  const events = (data ?? []) as unknown as EventRow[];

  return (
    <main style={{ maxWidth: 900, margin: "0 auto", padding: "1.5rem 1rem" }}>
      <h1 style={{ margin: "0 0 0.25rem" }}>เหตุการณ์ล่าสุด</h1>
      <p style={{ margin: "0 0 1rem", color: "#777", fontSize: "0.9rem" }}>
        แสดง 50 รายการล่าสุด · รีเฟรชหน้า (ปัดลง/F5) เพื่อดูข้อมูลใหม่
      </p>

      {error && (
        <p style={{ color: "#b00" }}>ดึงข้อมูลไม่สำเร็จ: {error.message}</p>
      )}
      {!error && events.length === 0 && <p>ยังไม่มีเหตุการณ์ในระบบ</p>}

      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        {events.map((ev) => {
          const isAlarm = ALARM_TYPES.includes(ev.event_type);
          return (
            <div
              key={ev.event_id}
              style={{
                border: "1px solid #e0e0e0",
                borderLeft: `5px solid ${isAlarm ? "#d9534f" : "#5bc0de"}`,
                borderRadius: 8,
                padding: "0.6rem 0.9rem",
                display: "flex",
                flexWrap: "wrap",
                gap: "0.25rem 1rem",
                alignItems: "baseline",
              }}
            >
              <strong>{TYPE_TH[ev.event_type] ?? ev.event_type}</strong>
              <span>{ev.cameras?.name ?? "ไม่ระบุกล้อง"}</span>
              {ev.ai?.verified === false && (
                <span style={{ color: "#999", fontSize: "0.85rem" }}>
                  AI: น่าจะแจ้งเตือนหลอก
                </span>
              )}
              {ev.ai?.description_th && (
                <span style={{ flexBasis: "100%", color: "#333" }}>
                  🤖 {ev.ai.description_th}
                </span>
              )}
              {ev.detection?.zone && <span>โซน: {ev.detection.zone}</span>}
              {ev.detection?.plate && <span>ทะเบียน: {ev.detection.plate}</span>}
              <span style={{ color: "#777", fontSize: "0.85rem" }}>
                {formatThaiTime(ev.occurred_at)} · {ev.sites?.name ?? ""} ·{" "}
                {ev.source_type}
              </span>
            </div>
          );
        })}
      </div>
    </main>
  );
}
