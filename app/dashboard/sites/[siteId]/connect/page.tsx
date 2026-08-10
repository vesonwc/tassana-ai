import Link from "next/link";
import { notFound } from "next/navigation";
import { getSessionClient, getUserAndProfile } from "@/lib/supabase-auth";
import { formatThaiTime } from "@/lib/labels";
import { rotateSiteKey } from "@/app/dashboard/admin/actions";

export const dynamic = "force-dynamic";

const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ?? "https://tassana-ai.vercel.app";

export default async function ConnectPage({
  params,
}: {
  params: Promise<{ siteId: string }>;
}) {
  const session = await getUserAndProfile();
  if (!session || session.profile.role !== "admin") notFound();

  const { siteId } = await params;
  const supabase = await getSessionClient();
  const { data: site } = await supabase
    .from("sites")
    .select("id, name, site_key")
    .eq("id", siteId)
    .maybeSingle();
  if (!site) notFound();

  const { data: cameras } = await supabase
    .from("cameras")
    .select("id, name, enabled, source_type, source_camera_ref, last_event_at")
    .eq("site_id", siteId)
    .order("created_at");

  const webhookUrl = `${APP_URL}/api/webhook/${site.site_key}`;
  const box = { background: "#fff", borderRadius: 16, padding: "1rem 1.1rem", marginBottom: "0.9rem" } as const;

  return (
    <main style={{ maxWidth: 680 }}>
      <div style={{ display: "flex", alignItems: "baseline" }}>
        <h1 style={{ margin: 0, fontSize: "1.3rem" }}>🔌 เชื่อมกล้อง — {site.name}</h1>
        <Link href={`/dashboard/sites/${siteId}`} style={{ fontSize: "0.9rem", color: "#9E9E9E", marginLeft: "auto" }}>← กลับ</Link>
      </div>
      <p style={{ margin: "0.25rem 0 1rem", color: "#9E9E9E", fontSize: "0.9rem" }}>
        หน้านี้เห็นเฉพาะทีมงาน Tassana (มีกุญแจลับของโครงการ)
      </p>

      <section style={box}>
        <h2 style={{ margin: "0 0 0.35rem", fontSize: "1.05rem" }}>1. ที่อยู่รับ event ของโครงการนี้</h2>
        <p style={{ margin: "0 0 0.5rem", color: "#9E9E9E", fontSize: "0.85rem" }}>
          นำ URL นี้ไปใส่ใน NVR/กล้อง — ทุก event จะวิ่งเข้าโครงการนี้อัตโนมัติ
        </p>
        <code style={{ display: "block", background: "#F4F5F6", borderRadius: 8, padding: "0.6rem 0.8rem", fontSize: "0.8rem", wordBreak: "break-all", userSelect: "all" }}>
          {webhookUrl}
        </code>
        <form action={rotateSiteKey} style={{ marginTop: "0.6rem" }}>
          <input type="hidden" name="siteId" value={siteId} />
          <button style={{ fontSize: "0.85rem", padding: "0.35rem 0.9rem", borderRadius: 999, border: "1px solid #ccd0d5", background: "#fff", cursor: "pointer" }}>
            🔑 เปลี่ยนกุญแจใหม่ (ของเก่าจะใช้ไม่ได้ทันที)
          </button>
        </form>
      </section>

      <section style={box}>
        <h2 style={{ margin: "0 0 0.35rem", fontSize: "1.05rem" }}>2. วิธีตั้งค่าฝั่งกล้อง/NVR</h2>
        <p style={{ margin: "0 0 0.4rem", fontSize: "0.9rem" }}><strong>Hikvision:</strong> เข้าเว็บ NVR → Configuration → Network → Advanced → <em>HTTP Listening</em> (บางรุ่นอยู่ใน Event → Notify Surveillance Center) → ใส่ URL ข้างบน → เปิด Smart Event (Line Crossing / Intrusion) ที่กล้องแต่ละตัว แล้วติ๊ก "Notify Surveillance Center"</p>
        <p style={{ margin: "0 0 0.4rem", fontSize: "0.9rem" }}><strong>Dahua:</strong> (adapter อยู่ระหว่างพัฒนา — แจ้งทีมงานก่อนติดตั้ง)</p>
        <p style={{ margin: 0, color: "#C0392B", fontSize: "0.85rem" }}>
          ⚠️ ห้าม port forward NVR ออกเน็ตเด็ดขาด — การเชื่อมต่อขาออกผ่าน URL นี้ หรือผ่าน Tailscale เท่านั้น (ADR-007)
        </p>
      </section>

      <section style={box}>
        <h2 style={{ margin: "0 0 0.35rem", fontSize: "1.05rem" }}>3. กล้องที่ระบบรู้จัก ({(cameras ?? []).length} ตัว)</h2>
        <p style={{ margin: "0 0 0.6rem", color: "#9E9E9E", fontSize: "0.85rem" }}>
          กล้องใหม่จะโผล่ที่นี่เองเมื่อยิง event แรกเข้ามา (สถานะปิดไว้ก่อน) — เปิดใช้/ตั้งชื่อ/เลือกหน้าที่ได้ในหน้า ⚙️ ตั้งค่า
        </p>
        {(cameras ?? []).map((cam) => (
          <div key={cam.id} style={{ display: "flex", gap: "0.6rem", alignItems: "baseline", padding: "0.4rem 0", borderBottom: "1px solid #f0f1f3", fontSize: "0.92rem", flexWrap: "wrap" }}>
            <strong>{cam.name}</strong>
            <span style={{ color: "#9E9E9E", fontSize: "0.8rem" }}>
              {cam.source_type} · ช่อง {cam.source_camera_ref ?? "-"}
            </span>
            <span style={{ marginLeft: "auto", fontSize: "0.8rem", fontWeight: 600, color: cam.enabled ? "#009E4A" : "#9E9E9E" }}>
              {cam.enabled ? "● เปิดใช้" : "○ ยังไม่เปิดใช้"}
            </span>
            <span style={{ color: "#9E9E9E", fontSize: "0.8rem" }}>
              {cam.last_event_at ? `ล่าสุด ${formatThaiTime(cam.last_event_at)}` : "ยังไม่มี event"}
            </span>
          </div>
        ))}
        {(cameras ?? []).length === 0 && (
          <p style={{ color: "#9E9E9E", fontSize: "0.9rem" }}>ยังไม่มีกล้อง — ตั้งค่า NVR ตามข้อ 2 แล้วรอ event แรก</p>
        )}
      </section>
    </main>
  );
}
