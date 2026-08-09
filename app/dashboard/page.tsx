import Link from "next/link";
import { getSessionClient } from "@/lib/supabase-auth";

// Home = one card per site. Green/red status a guard can read at a glance.
const OFFLINE_AFTER_MIN = 10;

interface SiteRow {
  id: string;
  name: string;
  heartbeat_at: string | null;
  status: string;
}

function siteHealth(site: SiteRow): {
  label: string;
  color: string;
  bg: string;
} {
  if (!site.heartbeat_at) {
    return { label: "ยังไม่เชื่อมต่อกล้อง", color: "#9E9E9E", bg: "#eef0f2" };
  }
  const silentMs = Date.now() - new Date(site.heartbeat_at).getTime();
  if (silentMs > OFFLINE_AFTER_MIN * 60_000) {
    return { label: "ขาดการติดต่อ — ควรตรวจสอบ", color: "#C0392B", bg: "#FDECEC" };
  }
  return { label: "ทำงานปกติ", color: "#009E4A", bg: "rgba(0,222,104,0.12)" };
}

export default async function DashboardHome() {
  const supabase = await getSessionClient();
  const { data } = await supabase
    .from("sites")
    .select("id, name, heartbeat_at, status")
    .order("name");
  const sites = (data ?? []) as SiteRow[];

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const counts = await Promise.all(
    sites.map(async (site) => {
      const { count } = await supabase
        .from("events")
        .select("event_id", { count: "exact", head: true })
        .eq("site_id", site.id)
        .gte("occurred_at", startOfToday.toISOString());
      return count ?? 0;
    }),
  );

  return (
    <main>
      <h1 style={{ margin: "0 0 0.25rem", fontSize: "1.4rem" }}>โครงการของคุณ</h1>
      <p style={{ margin: "0 0 1rem", color: "#9E9E9E", fontSize: "0.9rem" }}>
        แตะที่โครงการเพื่อดูเหตุการณ์
      </p>

      {sites.length === 0 && (
        <p style={{ color: "#9E9E9E" }}>
          ยังไม่มีโครงการที่คุณเข้าถึงได้ — ติดต่อทีมงาน Tassana AI
        </p>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
          gap: "0.9rem",
        }}
      >
        {sites.map((site, i) => {
          const health = siteHealth(site);
          return (
            <Link
              key={site.id}
              href={`/dashboard/sites/${site.id}`}
              style={{
                display: "block",
                background: "#fff",
                border: "1px solid #e3e5e8",
                borderRadius: 16,
                padding: "1rem 1.1rem",
                textDecoration: "none",
                color: "inherit",
              }}
            >
              <div style={{ fontWeight: 700, fontSize: "1.05rem", marginBottom: 6 }}>
                {site.name}
              </div>
              <span
                style={{
                  display: "inline-block",
                  fontSize: "0.8rem",
                  fontWeight: 600,
                  color: health.color,
                  background: health.bg,
                  padding: "0.2rem 0.6rem",
                  borderRadius: 999,
                }}
              >
                ● {health.label}
              </span>
              <div style={{ marginTop: 10, color: "#1D1D1F", fontSize: "0.9rem" }}>
                เหตุการณ์วันนี้: <strong>{counts[i]}</strong> รายการ
              </div>
            </Link>
          );
        })}
      </div>
    </main>
  );
}
