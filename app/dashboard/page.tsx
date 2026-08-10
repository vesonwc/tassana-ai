import Link from "next/link";
import { getSessionClient, getUserAndProfile } from "@/lib/supabase-auth";

// Overview: a guard should answer "anything today? is it still watching?"
// from one glance; an admin additionally sees fleet + billing-relevant numbers.
const OFFLINE_AFTER_MIN = 10;

interface SiteRow {
  id: string;
  name: string;
  heartbeat_at: string | null;
  status: string;
}

interface CameraLite {
  site_id: string;
  enabled: boolean;
  last_event_at: string | null;
}

interface EventLite {
  site_id: string;
  ai: { verified: boolean | null; severity: string | null } | null;
}

function siteHealth(site: SiteRow): { label: string; color: string; bg: string } {
  if (!site.heartbeat_at) {
    return { label: "ยังไม่เชื่อมต่อกล้อง", color: "#9E9E9E", bg: "#eef0f2" };
  }
  const silentMs = Date.now() - new Date(site.heartbeat_at).getTime();
  if (silentMs > OFFLINE_AFTER_MIN * 60_000) {
    return { label: "ขาดการติดต่อ — ควรตรวจสอบ", color: "#C0392B", bg: "#FDECEC" };
  }
  return { label: "ทำงานปกติ", color: "#009E4A", bg: "rgba(0,222,104,0.12)" };
}

function isCameraLive(cam: CameraLite): boolean {
  return (
    !!cam.last_event_at &&
    Date.now() - new Date(cam.last_event_at).getTime() < OFFLINE_AFTER_MIN * 60_000
  );
}

const stat = {
  background: "#fff",
  borderRadius: 16,
  padding: "0.7rem 1rem",
  minWidth: 120,
  flex: 1,
} as const;

export default async function DashboardHome() {
  const session = await getUserAndProfile();
  const isAdmin = session?.profile.role === "admin";

  const supabase = await getSessionClient();
  const { data: siteData } = await supabase
    .from("sites")
    .select("id, name, heartbeat_at, status")
    .order("name");
  const sites = (siteData ?? []) as SiteRow[];

  const { data: cameraData } = await supabase
    .from("cameras")
    .select("site_id, enabled, last_event_at");
  const cameras = (cameraData ?? []) as CameraLite[];

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const { data: eventData } = await supabase
    .from("events")
    .select("site_id, ai")
    .gte("occurred_at", startOfToday.toISOString())
    .limit(5000);
  const events = (eventData ?? []) as EventLite[];

  const perSite = new Map<string, { total: number; abnormal: number }>();
  for (const ev of events) {
    const entry = perSite.get(ev.site_id) ?? { total: 0, abnormal: 0 };
    entry.total += 1;
    if (
      ev.ai?.verified === true &&
      (ev.ai.severity === "warning" || ev.ai.severity === "critical")
    ) {
      entry.abnormal += 1;
    }
    perSite.set(ev.site_id, entry);
  }

  const enabledCams = cameras.filter((c) => c.enabled).length;
  const pendingCams = cameras.length - enabledCams;
  const totalToday = events.length;
  const totalAbnormal = [...perSite.values()].reduce((s, v) => s + v.abnormal, 0);

  // Dead-man switch (ADR-012)
  let workerDown = false;
  if (isAdmin) {
    const { data: status } = await supabase
      .from("system_status")
      .select("updated_at")
      .eq("key", "worker_heartbeat")
      .maybeSingle();
    if (status?.updated_at) {
      workerDown = Date.now() - new Date(status.updated_at).getTime() > 5 * 60_000;
    }
  }

  return (
    <main>
      {workerDown && (
        <p style={{ background: "#FDECEC", color: "#C0392B", fontWeight: 600, padding: "0.7rem 1rem", borderRadius: 12, marginTop: 0 }}>
          🚨 ระบบวิเคราะห์ AI หยุดทำงานเกิน 5 นาที — ตรวจสอบ Railway ด่วน (event ยังถูกบันทึกอยู่ ไม่หาย)
        </p>
      )}

      <div style={{ display: "flex", alignItems: "baseline", gap: "0.75rem", flexWrap: "wrap" }}>
        <h1 style={{ margin: "0 0 0.25rem", fontSize: "1.4rem" }}>โครงการของคุณ</h1>
        {isAdmin && (
          <span style={{ marginLeft: "auto", display: "flex", gap: "0.75rem" }}>
            <Link href="/dashboard/admin/new-site" style={{ fontSize: "0.9rem", color: "#009E4A", fontWeight: 500 }}>
              ➕ เปิดโครงการใหม่
            </Link>
            <Link href="/dashboard/admin/new-user" style={{ fontSize: "0.9rem", color: "#009E4A", fontWeight: 500 }}>
              👤 เพิ่มผู้ใช้
            </Link>
          </span>
        )}
      </div>

      {isAdmin && (
        <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap", margin: "0.6rem 0 1rem" }}>
          <div style={stat}>
            <div style={{ fontSize: "0.75rem", color: "#9E9E9E" }}>ระบบวิเคราะห์</div>
            <div style={{ fontSize: "1.1rem", fontWeight: 700, color: workerDown ? "#C0392B" : "#009E4A" }}>
              {workerDown ? "● หยุดทำงาน" : "● ออนไลน์"}
            </div>
          </div>
          <div style={stat}>
            <div style={{ fontSize: "0.75rem", color: "#9E9E9E" }}>โครงการ</div>
            <div style={{ fontSize: "1.1rem", fontWeight: 700 }}>{sites.length}</div>
          </div>
          <div style={stat}>
            <div style={{ fontSize: "0.75rem", color: "#9E9E9E" }}>กล้องเปิดใช้ (เก็บเงินได้)</div>
            <div style={{ fontSize: "1.1rem", fontWeight: 700 }}>
              {enabledCams}
              <span style={{ fontSize: "0.8rem", fontWeight: 400, color: "#9E9E9E" }}>
                {" "}/ {cameras.length}{pendingCams > 0 ? ` (รอเปิด ${pendingCams})` : ""}
              </span>
            </div>
          </div>
          <div style={stat}>
            <div style={{ fontSize: "0.75rem", color: "#9E9E9E" }}>เหตุการณ์วันนี้</div>
            <div style={{ fontSize: "1.1rem", fontWeight: 700 }}>{totalToday}</div>
          </div>
          <div style={stat}>
            <div style={{ fontSize: "0.75rem", color: "#9E9E9E" }}>ผิดปกติวันนี้</div>
            <div style={{ fontSize: "1.1rem", fontWeight: 700, color: totalAbnormal > 0 ? "#C0392B" : "#1D1D1F" }}>
              {totalAbnormal}
            </div>
          </div>
        </div>
      )}

      <p style={{ margin: "0 0 1rem", color: "#9E9E9E", fontSize: "0.9rem" }}>
        แตะที่โครงการเพื่อดูเหตุการณ์
      </p>

      {sites.length === 0 && (
        <p style={{ color: "#9E9E9E" }}>ยังไม่มีโครงการที่คุณเข้าถึงได้ — ติดต่อทีมงาน Tassana AI</p>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: "0.9rem" }}>
        {sites.map((site) => {
          const health = siteHealth(site);
          const stats = perSite.get(site.id) ?? { total: 0, abnormal: 0 };
          const siteCams = cameras.filter((c) => c.site_id === site.id && c.enabled);
          const liveCams = siteCams.filter(isCameraLive).length;
          return (
            <Link
              key={site.id}
              href={`/dashboard/sites/${site.id}`}
              style={{ display: "block", background: "#fff", border: "1px solid #e3e5e8", borderRadius: 16, padding: "1rem 1.1rem", textDecoration: "none", color: "inherit" }}
            >
              <div style={{ fontWeight: 700, fontSize: "1.05rem", marginBottom: 6 }}>{site.name}</div>
              <span style={{ display: "inline-block", fontSize: "0.8rem", fontWeight: 600, color: health.color, background: health.bg, padding: "0.2rem 0.6rem", borderRadius: 999 }}>
                ● {health.label}
              </span>
              <div style={{ marginTop: 10, fontSize: "0.9rem", display: "flex", gap: "0.9rem", flexWrap: "wrap" }}>
                <span style={{ color: stats.abnormal > 0 ? "#C0392B" : "#9E9E9E", fontWeight: stats.abnormal > 0 ? 700 : 400 }}>
                  🔴 ผิดปกติ {stats.abnormal}
                </span>
                <span style={{ color: "#1D1D1F" }}>เหตุการณ์ {stats.total}</span>
                {siteCams.length > 0 && (
                  <span style={{ color: liveCams < siteCams.length ? "#C0392B" : "#9E9E9E" }}>
                    📷 {liveCams}/{siteCams.length} ส่งสัญญาณ
                  </span>
                )}
              </div>
            </Link>
          );
        })}
      </div>
    </main>
  );
}
