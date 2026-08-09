import Link from "next/link";
import { notFound } from "next/navigation";
import { getSessionClient } from "@/lib/supabase-auth";
import { saveSiteRules } from "./actions";

export const dynamic = "force-dynamic";

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

export default async function SiteSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ siteId: string }>;
  searchParams: Promise<{ saved?: string }>;
}) {
  const { siteId } = await params;
  const { saved } = await searchParams;

  const supabase = await getSessionClient();
  const { data: site } = await supabase
    .from("sites")
    .select("id, name, rules")
    .eq("id", siteId)
    .maybeSingle();
  if (!site) notFound();

  const rules = (site.rules ?? {}) as Rules;
  const alertOn = (key: string) => rules.alerts?.[key] ?? true;

  const box = {
    background: "#fff",
    border: "1px solid #e3e5e8",
    borderRadius: 16,
    padding: "1rem 1.1rem",
    marginBottom: "0.9rem",
  } as const;

  return (
    <main style={{ maxWidth: 640 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: "0.75rem" }}>
        <h1 style={{ margin: 0, fontSize: "1.3rem" }}>ตั้งค่า — {site.name}</h1>
        <Link href={`/dashboard/sites/${siteId}`} style={{ fontSize: "0.9rem", color: "#9E9E9E", marginLeft: "auto" }}>
          ← กลับ
        </Link>
      </div>
      <p style={{ margin: "0.25rem 0 1rem", color: "#9E9E9E", fontSize: "0.9rem" }}>
        เลือกได้ว่าอยากให้ระบบแจ้งเตือนเรื่องอะไรบ้าง กดบันทึกด้านล่างเมื่อเสร็จ
      </p>

      {saved && (
        <p style={{ background: "rgba(0,222,104,0.12)", color: "#009E4A", padding: "0.6rem 0.9rem", borderRadius: 8, fontWeight: 600 }}>
          ✓ บันทึกการตั้งค่าแล้ว
        </p>
      )}

      <form action={saveSiteRules}>
        <input type="hidden" name="siteId" value={siteId} />

        <section style={box}>
          <h2 style={{ margin: "0 0 0.6rem", fontSize: "1.05rem" }}>🔔 แจ้งเตือนเมื่อ...</h2>
          {ALERT_CHOICES.map((c) => (
            <label
              key={c.key}
              style={{ display: "flex", gap: "0.6rem", alignItems: "flex-start", padding: "0.45rem 0", borderBottom: "1px solid #f0f1f3", cursor: "pointer" }}
            >
              <input
                type="checkbox"
                name={`alert_${c.key}`}
                defaultChecked={alertOn(c.key)}
                style={{ width: 18, height: 18, marginTop: 2 }}
              />
              <span>
                {c.label}
                {c.hint && (
                  <span style={{ display: "block", color: "#9E9E9E", fontSize: "0.8rem" }}>{c.hint}</span>
                )}
              </span>
            </label>
          ))}
        </section>

        <section style={box}>
          <h2 style={{ margin: "0 0 0.35rem", fontSize: "1.05rem" }}>🌙 ช่วงเวลาเฝ้าระวังเข้มข้น</h2>
          <p style={{ margin: "0 0 0.6rem", color: "#9E9E9E", fontSize: "0.85rem" }}>
            ช่วงเวลานี้ระบบจะถือว่าทุกความเคลื่อนไหวสำคัญเป็นพิเศษ (เช่น กลางดึก)
          </p>
          <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
            ตั้งแต่
            <input type="time" name="strict_start" defaultValue={rules.strict_hours?.start ?? "22:00"} style={{ padding: "0.4rem", borderRadius: 8, border: "1px solid #ccd0d5", fontSize: "1rem" }} />
            ถึง
            <input type="time" name="strict_end" defaultValue={rules.strict_hours?.end ?? "06:00"} style={{ padding: "0.4rem", borderRadius: 8, border: "1px solid #ccd0d5", fontSize: "1rem" }} />
          </div>
        </section>

        <section style={box}>
          <h2 style={{ margin: "0 0 0.35rem", fontSize: "1.05rem" }}>🎚️ ความไวของระบบ</h2>
          <p style={{ margin: "0 0 0.6rem", color: "#9E9E9E", fontSize: "0.85rem" }}>
            ไวมาก = เตือนบ่อยไม่พลาดอะไรเลย · เข้มงวด = เตือนเฉพาะที่มั่นใจจริง ๆ
          </p>
          <select name="sensitivity" defaultValue={rules.sensitivity ?? "medium"} style={{ padding: "0.5rem", borderRadius: 8, border: "1px solid #ccd0d5", fontSize: "1rem", width: "100%" }}>
            <option value="high">ไวมาก — แจ้งทุกอย่างที่น่าสงสัย</option>
            <option value="medium">สมดุล (แนะนำ)</option>
            <option value="low">เข้มงวด — แจ้งเฉพาะเหตุที่มั่นใจสูง</option>
          </select>
        </section>

        <button
          type="submit"
          style={{ width: "100%", padding: "0.85rem", fontSize: "1.05rem", fontWeight: 700, color: "#003D1C", background: "#00DE68", border: "none", borderRadius: 999, cursor: "pointer" }}
        >
          💾 บันทึกการตั้งค่า
        </button>
      </form>
    </main>
  );
}
