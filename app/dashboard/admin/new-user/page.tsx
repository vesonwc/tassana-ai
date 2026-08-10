import Link from "next/link";
import { notFound } from "next/navigation";
import { getSessionClient, getUserAndProfile } from "@/lib/supabase-auth";
import UserForm from "./user-form";

export const dynamic = "force-dynamic";

export default async function NewUserPage() {
  const session = await getUserAndProfile();
  if (!session || session.profile.role !== "admin") notFound();

  const supabase = await getSessionClient();
  const { data: sites } = await supabase
    .from("sites")
    .select("id, name")
    .order("name");

  return (
    <main style={{ maxWidth: 520 }}>
      <div style={{ display: "flex", alignItems: "baseline" }}>
        <h1 style={{ margin: 0, fontSize: "1.3rem" }}>👤 เพิ่มผู้ใช้</h1>
        <Link href="/dashboard" style={{ fontSize: "0.9rem", color: "#9E9E9E", marginLeft: "auto" }}>← กลับ</Link>
      </div>
      <p style={{ margin: "0.25rem 0 1rem", color: "#9E9E9E", fontSize: "0.9rem" }}>
        สร้างบัญชีให้ลูกค้าหรือทีมงาน — ระบบสุ่มรหัสผ่านให้ ก๊อปส่งได้ทันที
      </p>
      <UserForm sites={sites ?? []} />
    </main>
  );
}
