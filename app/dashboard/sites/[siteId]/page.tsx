import Link from "next/link";
import { notFound } from "next/navigation";
import { getSessionClient } from "@/lib/supabase-auth";
import { getServiceClient } from "@/lib/supabase";
import { ALARM_TYPES, formatThaiTime, TYPE_TH } from "@/lib/labels";
import type { EventType } from "@/lib/types";
import { submitEventFeedback } from "./actions";

export const dynamic = "force-dynamic";

interface EventRow {
  event_id: string;
  event_type: EventType;
  occurred_at: string;
  detection: { zone: string | null; plate: string | null } | null;
  media: { snapshot_path: string | null } | null;
  ai: { verified: boolean | null; severity: string | null; description_th: string | null } | null;
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
  searchParams: Promise<{ days?: string; camera?: string; type?: string }>;
}) {
  const { siteId } = await params;
  const { days = "1", camera = "", type = "" } = await searchParams;

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

  const { data } = await query;
  const events = (data ?? []) as unknown as EventRow[];

  // Snapshot URLs: bucket is private; sign for one hour via the service client.
  const service = getServiceClient();
  const imageUrls = new Map<string, string>();
  await Promise.all(
    events
      .filter((ev) => ev.media?.snapshot_path)
      .map(async (ev) => {
        const { data: signed } = await service.storage
          .from("snapshots")
          .createSignedUrl(ev.media!.snapshot_path!, 3600);
        if (signed?.signedUrl) imageUrls.set(ev.event_id, signed.signedUrl);
      }),
  );

  return (
    <main>
      <div style={{ display: "flex", alignItems: "baseline", gap: "0.75rem", flexWrap: "wrap" }}>
        <h1 style={{ margin: 0, fontSize: "1.3rem" }}>{site.name}</h1>
        <Link
          href={`/dashboard/sites/${siteId}/settings`}
          style={{ fontSize: "0.9rem", color: "#1a6fb0" }}
        >
          ⚙️ ตั้งค่าการแจ้งเตือน
        </Link>
        <Link href="/dashboard" style={{ fontSize: "0.9rem", color: "#667", marginLeft: "auto" }}>
          ← ทุกโครงการ
        </Link>
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
        <button
          type="submit"
          style={{ padding: "0.45rem 0.9rem", borderRadius: 8, border: "1px solid #1a7f37", background: "#1a7f37", color: "#fff", fontSize: "0.95rem", cursor: "pointer" }}
        >
          แสดง
        </button>
      </form>

      {events.length === 0 && (
        <p style={{ color: "#667" }}>ไม่มีเหตุการณ์ในช่วงที่เลือก</p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "0.7rem" }}>
        {events.map((ev) => {
          const isAlarm = ALARM_TYPES.includes(ev.event_type);
          const feedback = ev.alerts?.[0]?.feedback ?? null;
          const img = imageUrls.get(ev.event_id);
          return (
            <div
              key={ev.event_id}
              style={{
                background: "#fff",
                border: "1px solid #e3e5e8",
                borderLeft: `5px solid ${isAlarm ? "#d9534f" : "#7fb3d8"}`,
                borderRadius: 10,
                padding: "0.75rem 0.9rem",
                display: "flex",
                gap: "0.9rem",
                alignItems: "flex-start",
                flexWrap: "wrap",
              }}
            >
              {img && (
                <a href={img} target="_blank" rel="noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={img}
                    alt="ภาพเหตุการณ์"
                    style={{ width: 140, borderRadius: 8, display: "block" }}
                  />
                </a>
              )}
              <div style={{ flex: 1, minWidth: 220 }}>
                <div style={{ fontWeight: 700 }}>
                  {TYPE_TH[ev.event_type] ?? ev.event_type}
                  <span style={{ fontWeight: 400, color: "#667", marginLeft: 8, fontSize: "0.85rem" }}>
                    {ev.cameras?.name ?? "ไม่ระบุกล้อง"} · {formatThaiTime(ev.occurred_at)}
                  </span>
                </div>
                {ev.ai?.description_th && (
                  <div style={{ marginTop: 4, color: "#223" }}>🤖 {ev.ai.description_th}</div>
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
                    <span style={{ color: "#1a7f37", fontSize: "0.85rem" }}>✓ ยืนยันว่าเป็นเหตุจริงแล้ว</span>
                  ) : (
                    <form action={submitEventFeedback} style={{ display: "inline-flex", gap: "0.4rem" }}>
                      <input type="hidden" name="eventId" value={ev.event_id} />
                      <input type="hidden" name="siteId" value={siteId} />
                      <button name="feedback" value="false_alarm" style={{ fontSize: "0.85rem", padding: "0.25rem 0.6rem", borderRadius: 8, border: "1px solid #ccd0d5", background: "#fff", cursor: "pointer" }}>
                        แจ้งเท็จ
                      </button>
                      <button name="feedback" value="confirmed" style={{ fontSize: "0.85rem", padding: "0.25rem 0.6rem", borderRadius: 8, border: "1px solid #ccd0d5", background: "#fff", cursor: "pointer" }}>
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
