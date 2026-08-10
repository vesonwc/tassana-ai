import Link from "next/link";
import { notFound } from "next/navigation";
import { getSessionClient, getUserAndProfile } from "@/lib/supabase-auth";
import { createSite } from "../actions";

export const dynamic = "force-dynamic";

export default async function NewSitePage() {
  const session = await getUserAndProfile();
  if (!session || session.profile.role !== "admin") notFound();

  const supabase = await getSessionClient();
  const { data: templates } = await supabase
    .from("site_templates")
    .select("id, name_th, description_th")
    .order("name_th");

  return (
    <main style={{ maxWidth: 520 }}>
      <div style={{ display: "flex", alignItems: "baseline" }}>
        <h1 style={{ margin: 0, fontSize: "1.3rem" }}>➕ เปิดโครงการใหม่</h1>
        <Link href="/dashboard" style={{ fontSize: "0.9rem", color: "#9E9E9E", marginLeft: "auto" }}>← กลับ</Link>
      </div>
      <p style={{ margin: "0.25rem 0 1rem", color: "#9E9E9E", fontSize: "0.9rem" }}>
        ตั้งชื่อ เลือกแม่แบบ แล้วระบบจะพาไปหน้าเชื่อมกล้องทันที
      </p>

      <form action={createSite} style={{ background: "#fff", borderRadius: 16, padding: "1.1rem", display: "flex", flexDirection: "column", gap: "0.8rem" }}>
        <label style={{ fontSize: "0.9rem" }}>
          ชื่อโครงการ
          <input
            name="name"
            required
            placeholder="เช่น หมู่บ้านสุภาลัย คลอง 4"
            style={{ display: "block", width: "100%", marginTop: 4, padding: "0.6rem", borderRadius: 8, border: "1px solid #ccd0d5", fontSize: "1rem", boxSizing: "border-box" }}
          />
        </label>
        <label style={{ fontSize: "0.9rem" }}>
          แม่แบบไซต์
          <select
            name="templateId"
            style={{ display: "block", width: "100%", marginTop: 4, padding: "0.55rem", borderRadius: 8, border: "1px solid #ccd0d5", fontSize: "0.95rem" }}
          >
            <option value="">— ไม่ใช้แม่แบบ —</option>
            {(templates ?? []).map((t) => (
              <option key={t.id} value={t.id}>{t.name_th} — {t.description_th}</option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          style={{ padding: "0.7rem", fontSize: "1rem", fontWeight: 600, color: "#fff", background: "#1D1D1F", border: "none", borderRadius: 999, cursor: "pointer" }}
        >
          สร้างโครงการ →
        </button>
      </form>
    </main>
  );
}
