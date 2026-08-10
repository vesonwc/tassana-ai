"use client";

import { useActionState } from "react";
import { createUser, type CreateUserState } from "../actions";

export default function UserForm({
  sites,
}: {
  sites: { id: string; name: string }[];
}) {
  const [state, formAction, pending] = useActionState<CreateUserState, FormData>(
    createUser,
    {},
  );

  return (
    <form action={formAction} style={{ background: "#fff", borderRadius: 16, padding: "1.1rem", display: "flex", flexDirection: "column", gap: "0.8rem" }}>
      {state.error && (
        <p style={{ margin: 0, background: "#FDECEC", color: "#C0392B", padding: "0.5rem 0.75rem", borderRadius: 8, fontSize: "0.9rem" }}>
          {state.error}
        </p>
      )}
      {state.password && (
        <div style={{ background: "rgba(0,222,104,0.12)", borderRadius: 8, padding: "0.7rem 0.9rem", fontSize: "0.9rem" }}>
          <strong style={{ color: "#009E4A" }}>✓ สร้างบัญชีสำเร็จ</strong>
          <div style={{ marginTop: 4 }}>อีเมล: <code>{state.email}</code></div>
          <div>รหัสผ่านชั่วคราว: <code style={{ userSelect: "all" }}>{state.password}</code></div>
          <div style={{ color: "#9E9E9E", fontSize: "0.8rem", marginTop: 4 }}>
            ก๊อปส่งให้ลูกค้าเดี๋ยวนี้ — ปิดหน้านี้แล้วดูรหัสอีกไม่ได้
          </div>
        </div>
      )}

      <label style={{ fontSize: "0.9rem" }}>
        อีเมลผู้ใช้
        <input name="email" type="email" required placeholder="line-manager@example.com"
          style={{ display: "block", width: "100%", marginTop: 4, padding: "0.6rem", borderRadius: 8, border: "1px solid #ccd0d5", fontSize: "1rem", boxSizing: "border-box" }} />
      </label>
      <label style={{ fontSize: "0.9rem" }}>
        สิทธิ์
        <select name="role" style={{ display: "block", width: "100%", marginTop: 4, padding: "0.55rem", borderRadius: 8, border: "1px solid #ccd0d5", fontSize: "0.95rem" }}>
          <option value="site_user">ลูกค้า — เห็นเฉพาะโครงการของตัวเอง</option>
          <option value="admin">ทีมงาน Tassana — เห็นทุกโครงการ</option>
        </select>
      </label>
      <label style={{ fontSize: "0.9rem" }}>
        โครงการ (สำหรับสิทธิ์ลูกค้า)
        <select name="siteId" style={{ display: "block", width: "100%", marginTop: 4, padding: "0.55rem", borderRadius: 8, border: "1px solid #ccd0d5", fontSize: "0.95rem" }}>
          <option value="">— เลือกโครงการ —</option>
          {sites.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      </label>
      <button type="submit" disabled={pending}
        style={{ padding: "0.7rem", fontSize: "1rem", fontWeight: 600, color: "#fff", background: "#1D1D1F", border: "none", borderRadius: 999, cursor: "pointer", opacity: pending ? 0.6 : 1 }}>
        {pending ? "กำลังสร้าง..." : "สร้างบัญชี"}
      </button>
    </form>
  );
}
