import Link from "next/link";
import { notFound } from "next/navigation";
import { getSessionClient, getUserAndProfile } from "@/lib/supabase-auth";
import { formatThaiTime } from "@/lib/labels";
import { saveCameraConfig, saveSiteRules } from "./actions";
import { rotateSiteKey } from "@/app/dashboard/admin/actions";

export const dynamic = "force-dynamic";

const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ?? "https://tassana-ai.vercel.app";

const ALERT_CHOICES: { key: string; label: string; hint: string }[] = [
  { key: "intrusion", label: "มีคนบุกรุกโซนหวงห้าม", hint: "สำคัญที่สุด — แนะนำเปิดไว้เสมอ" },
  { key: "line_crossing", label: "มีคนข้ามแนวรั้ว/เส้นกั้น", hint: "แนะนำเปิดไว้เสมอ" },
  { key: "loitering", label: "มีคนเดินเตร่ผิดปกติ", hint: "" },
  { key: "person_detected", label: "พบบุคคลในพื้นที่", hint: "ถ้าพื้นที่คนพลุกพล่าน อาจปิดเพื่อลดการรบกวน" },
  { key: "vehicle_detected", label: "พบยานพาหนะ", hint: "" },
  { key: "lpr", label: "อ่านป้ายทะเบียนรถ", hint: "" },
  { key: "camera_offline", label: "กล้องขาดการติดต่อ", hint: "แนะนำเปิดไว้เสมอ — จะได้รู้ทันทีที่กล้องดับ" },
];

interface Rules {
  alerts?: Record<string, boolean>;
  strict_hours?: { start: string; end: string };
  sensitivity?: string;
}

const box = {
  background: "#fff",
  borderRadius: 16,
  padding: "1rem 1.1rem",
  marginBottom: "0.9rem",
} as const;

const inputStyle = {
  padding: "0.5rem",
  borderRadius: 8,
  border: "1px solid #ccd0d5",
  fontSize: "0.95rem",
} as const;

function TabBar({
  siteId,
  active,
  cameraCount,
  isAdmin,
}: {
  siteId: string;
  active: string;
  cameraCount: number;
  isAdmin: boolean;
}) {
  const tabs = [
    { key: "alerts", label: "🔔 การแจ้งเตือน" },
    { key: "cameras", label: `📷 กล้อง (${cameraCount})` },
    ...(isAdmin ? [{ key: "connect", label: "🔌 การเชื่อมต่อ" }] : []),
  ];
  return (
    <nav style={{ display: "flex", gap: "0.4rem", margin: "0.9rem 0", flexWrap: "wrap" }}>
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={`/dashboard/sites/${siteId}/settings?tab=${t.key}`}
          style={{
            padding: "0.45rem 1.1rem",
            borderRadius: 999,
            fontSize: "0.92rem",
            fontWeight: 600,
            textDecoration: "none",
            background: active === t.key ? "#1D1D1F" : "#fff",
            color: active === t.key ? "#fff" : "#1D1D1F",
            border: active === t.key ? "1px solid #1D1D1F" : "1px solid #E3E5E8",
          }}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

export default async function SiteSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ siteId: string }>;
  searchParams: Promise<{ tab?: string; saved?: string; q?: string }>;
}) {
  const { siteId } = await params;
  const { tab: rawTab = "alerts", saved, q = "" } = await searchParams;

  const session = await getUserAndProfile();
  const isAdmin = session?.profile.role === "admin";
  const tab = rawTab === "connect" && !isAdmin ? "alerts" : rawTab;

  const supabase = await getSessionClient();
  const { data: site } = await supabase
    .from("sites")
    .select("id, name, rules, custom_instructions_th, site_key")
    .eq("id", siteId)
    .maybeSingle();
  if (!site) notFound();

  const { data: cameraRows } = await supabase
    .from("cameras")
    .select("id, name, enabled, profile_id, custom_instructions_th, source_type, source_camera_ref, last_event_at")
    .eq("site_id", siteId)
    .order("name");
  const cameras = cameraRows ?? [];

  const { data: profileRows } = await supabase
    .from("camera_profiles")
    .select("id, name_th, description_th")
    .order("name_th");
  const cameraProfiles = profileRows ?? [];

  const rules = (site.rules ?? {}) as Rules;
  const alertOn = (key: string) => rules.alerts?.[key] ?? true;
  const filteredCameras = q
    ? cameras.filter((c) => c.name.toLowerCase().includes(q.toLowerCase()))
    : cameras;
  const webhookUrl = `${APP_URL}/api/webhook/${site.site_key}`;

  return (
    <main style={{ maxWidth: 680 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: "0.75rem" }}>
        <h1 style={{ margin: 0, fontSize: "1.3rem" }}>ตั้งค่า — {site.name}</h1>
        <Link href={`/dashboard/sites/${siteId}`} style={{ fontSize: "0.9rem", color: "#9E9E9E", marginLeft: "auto" }}>
          ← กลับ
        </Link>
      </div>

      <TabBar siteId={siteId} active={tab} cameraCount={cameras.length} isAdmin={!!isAdmin} />

      {saved && (
        <p style={{ background: "rgba(0,222,104,0.12)", color: "#009E4A", padding: "0.6rem 0.9rem", borderRadius: 8, fontWeight: 600 }}>
          ✓ บันทึกแล้ว
        </p>
      )}

      {tab === "alerts" && (
        <form action={saveSiteRules}>
          <input type="hidden" name="siteId" value={siteId} />
          <section style={box}>
            <h2 style={{ margin: "0 0 0.6rem", fontSize: "1.05rem" }}>แจ้งเตือนเมื่อ...</h2>
            {ALERT_CHOICES.map((c) => (
              <label key={c.key} style={{ display: "flex", gap: "0.6rem", alignItems: "flex-start", padding: "0.45rem 0", borderBottom: "1px solid #f0f1f3", cursor: "pointer" }}>
                <input type="checkbox" name={`alert_${c.key}`} defaultChecked={alertOn(c.key)} style={{ width: 18, height: 18, marginTop: 2 }} />
                <span>
                  {c.label}
                  {c.hint && <span style={{ display: "block", color: "#9E9E9E", fontSize: "0.8rem" }}>{c.hint}</span>}
                </span>
              </label>
            ))}
          </section>

          <section style={box}>
            <h2 style={{ margin: "0 0 0.35rem", fontSize: "1.05rem" }}>🌙 ช่วงเวลาเฝ้าระวังเข้มข้น</h2>
            <p style={{ margin: "0 0 0.6rem", color: "#9E9E9E", fontSize: "0.85rem" }}>
              ช่วงเวลานี้ทุกความเคลื่อนไหวถือว่าสำคัญเป็นพิเศษ (เช่น กลางดึก)
            </p>
            <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
              ตั้งแต่
              <input type="time" name="strict_start" defaultValue={rules.strict_hours?.start ?? "22:00"} style={inputStyle} />
              ถึง
              <input type="time" name="strict_end" defaultValue={rules.strict_hours?.end ?? "06:00"} style={inputStyle} />
            </div>
          </section>

          <section style={box}>
            <h2 style={{ margin: "0 0 0.35rem", fontSize: "1.05rem" }}>🎚️ ความไวของระบบ</h2>
            <select name="sensitivity" defaultValue={rules.sensitivity ?? "medium"} style={{ ...inputStyle, width: "100%" }}>
              <option value="high">ไวมาก — แจ้งทุกอย่างที่น่าสงสัย</option>
              <option value="medium">สมดุล (แนะนำ)</option>
              <option value="low">เข้มงวด — แจ้งเฉพาะเหตุที่มั่นใจสูง</option>
            </select>
          </section>

          <section style={box}>
            <h2 style={{ margin: "0 0 0.35rem", fontSize: "1.05rem" }}>💬 คำสั่งพิเศษของโครงการนี้</h2>
            <p style={{ margin: "0 0 0.6rem", color: "#9E9E9E", fontSize: "0.85rem" }}>
              พิมพ์ภาษาไทยธรรมดา มีผลกับทุกกล้องทันที เช่น "ช่วงปิดปรับปรุงสระ ถ้ามีคนเข้าเขตสระให้แจ้งทันที"
            </p>
            <textarea
              name="site_instructions"
              defaultValue={site.custom_instructions_th ?? ""}
              rows={3}
              placeholder="ยังไม่มีคำสั่งพิเศษ"
              style={{ ...inputStyle, width: "100%", fontFamily: "inherit", boxSizing: "border-box" }}
            />
          </section>

          <button type="submit" style={{ width: "100%", padding: "0.85rem", fontSize: "1.05rem", fontWeight: 700, color: "#003D1C", background: "#00DE68", border: "none", borderRadius: 999, cursor: "pointer" }}>
            💾 บันทึกการแจ้งเตือน
          </button>
        </form>
      )}

      {tab === "cameras" && (
        <>
          {cameras.length > 8 && (
            <form method="get" style={{ marginBottom: "0.8rem", display: "flex", gap: "0.5rem" }}>
              <input type="hidden" name="tab" value="cameras" />
              <input name="q" defaultValue={q} placeholder="ค้นหาชื่อกล้อง..." style={{ ...inputStyle, flex: 1 }} />
              <button style={{ padding: "0.45rem 1.1rem", borderRadius: 999, border: "none", background: "#1D1D1F", color: "#fff", fontSize: "0.9rem", cursor: "pointer" }}>ค้นหา</button>
            </form>
          )}
          {filteredCameras.length === 0 && (
            <p style={{ color: "#9E9E9E" }}>ไม่พบกล้อง{q ? `ชื่อ "${q}"` : " — เชื่อมกล้องก่อนในแท็บ 🔌"}</p>
          )}
          {filteredCameras.map((cam) => (
            <form key={cam.id} action={saveCameraConfig}>
              <section style={box}>
                <input type="hidden" name="cameraId" value={cam.id} />
                <input type="hidden" name="siteId" value={siteId} />
                <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
                  <strong style={{ fontSize: "1rem" }}>{cam.name}</strong>
                  <label style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: "0.9rem" }}>
                    <input type="checkbox" name="enabled" defaultChecked={cam.enabled !== false} style={{ width: 18, height: 18 }} />
                    เปิดใช้ Tassana AI
                  </label>
                </div>
                <label style={{ display: "block", marginTop: "0.7rem", fontSize: "0.85rem", color: "#9E9E9E" }}>
                  หน้าที่ของกล้องนี้
                  <select name="profileId" defaultValue={cam.profile_id ?? ""} style={{ ...inputStyle, display: "block", width: "100%", marginTop: 4 }}>
                    <option value="">— ยังไม่กำหนด (ใช้เฉพาะกฎพื้นฐาน) —</option>
                    {cameraProfiles.map((p) => (
                      <option key={p.id} value={p.id}>{p.name_th} — {p.description_th}</option>
                    ))}
                  </select>
                </label>
                <label style={{ display: "block", marginTop: "0.7rem", fontSize: "0.85rem", color: "#9E9E9E" }}>
                  คำสั่งเพิ่มเติมเฉพาะกล้องนี้ (ภาษาไทยธรรมดา)
                  <textarea
                    name="instructions"
                    defaultValue={cam.custom_instructions_th ?? ""}
                    rows={2}
                    placeholder={'เช่น "ช่วยดูด้วยว่ามีรถมาจอดขวางประตูหนีไฟไหม"'}
                    style={{ ...inputStyle, display: "block", width: "100%", marginTop: 4, fontFamily: "inherit", boxSizing: "border-box" }}
                  />
                </label>
                <button type="submit" style={{ marginTop: "0.7rem", padding: "0.5rem 1.3rem", fontSize: "0.95rem", fontWeight: 600, color: "#fff", background: "#1D1D1F", border: "none", borderRadius: 999, cursor: "pointer" }}>
                  บันทึกกล้องนี้
                </button>
              </section>
            </form>
          ))}
        </>
      )}

      {tab === "connect" && isAdmin && (
        <>
          <section style={box}>
            <h2 style={{ margin: "0 0 0.35rem", fontSize: "1.05rem" }}>1. ที่อยู่รับ event ของโครงการนี้</h2>
            <p style={{ margin: "0 0 0.5rem", color: "#9E9E9E", fontSize: "0.85rem" }}>
              นำ URL นี้ไปใส่ใน NVR/กล้อง — แท็บนี้เห็นเฉพาะทีมงาน Tassana
            </p>
            <code style={{ display: "block", background: "#F4F5F6", borderRadius: 8, padding: "0.6rem 0.8rem", fontSize: "0.8rem", wordBreak: "break-all", userSelect: "all" }}>
              {webhookUrl}
            </code>
            <form action={rotateSiteKey} style={{ marginTop: "0.6rem" }}>
              <input type="hidden" name="siteId" value={siteId} />
              <button style={{ fontSize: "0.85rem", padding: "0.35rem 0.9rem", borderRadius: 999, border: "1px solid #ccd0d5", background: "#fff", cursor: "pointer" }}>
                🔑 เปลี่ยนกุญแจใหม่ (ของเก่าใช้ไม่ได้ทันที)
              </button>
            </form>
          </section>

          <section style={box}>
            <h2 style={{ margin: "0 0 0.35rem", fontSize: "1.05rem" }}>2. วิธีตั้งค่าฝั่งกล้อง/NVR</h2>
            <p style={{ margin: "0 0 0.4rem", fontSize: "0.9rem" }}>
              <strong>Hikvision:</strong> เว็บ NVR → Configuration → Network → Advanced → <em>HTTP Listening</em> (บางรุ่น: Event → Notify Surveillance Center) → ใส่ URL ข้างบน → เปิด Smart Event ที่กล้อง + ติ๊ก "Notify Surveillance Center"
            </p>
            <p style={{ margin: "0 0 0.4rem", fontSize: "0.9rem" }}><strong>Dahua:</strong> adapter อยู่ระหว่างพัฒนา</p>
            <p style={{ margin: 0, color: "#C0392B", fontSize: "0.85rem" }}>
              ⚠️ ห้าม port forward NVR ออกเน็ตเด็ดขาด (ADR-007)
            </p>
          </section>

          <section style={box}>
            <h2 style={{ margin: "0 0 0.35rem", fontSize: "1.05rem" }}>3. กล้องที่ระบบรู้จัก ({cameras.length} ตัว)</h2>
            <p style={{ margin: "0 0 0.6rem", color: "#9E9E9E", fontSize: "0.85rem" }}>
              กล้องใหม่โผล่ที่นี่เองเมื่อยิง event แรก (สถานะปิดไว้ก่อน) — เปิดใช้ได้ในแท็บ 📷
            </p>
            {cameras.map((cam) => (
              <div key={cam.id} style={{ display: "flex", gap: "0.6rem", alignItems: "baseline", padding: "0.4rem 0", borderBottom: "1px solid #f0f1f3", fontSize: "0.92rem", flexWrap: "wrap" }}>
                <strong>{cam.name}</strong>
                <span style={{ color: "#9E9E9E", fontSize: "0.8rem" }}>{cam.source_type} · ช่อง {cam.source_camera_ref ?? "-"}</span>
                <span style={{ marginLeft: "auto", fontSize: "0.8rem", fontWeight: 600, color: cam.enabled ? "#009E4A" : "#9E9E9E" }}>
                  {cam.enabled ? "● เปิดใช้" : "○ ยังไม่เปิดใช้"}
                </span>
                <span style={{ color: "#9E9E9E", fontSize: "0.8rem" }}>
                  {cam.last_event_at ? `ล่าสุด ${formatThaiTime(cam.last_event_at)}` : "ยังไม่มี event"}
                </span>
              </div>
            ))}
            {cameras.length === 0 && <p style={{ color: "#9E9E9E", fontSize: "0.9rem" }}>ยังไม่มีกล้อง — ตั้งค่า NVR ตามข้อ 2 แล้วรอ event แรก</p>}
          </section>
        </>
      )}
    </main>
  );
}
