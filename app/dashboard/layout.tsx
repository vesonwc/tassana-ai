import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getUserAndProfile } from "@/lib/supabase-auth";
import { signOut } from "@/app/login/actions";

export const metadata = { title: "Tassana AI — แดชบอร์ด" };

export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  const session = await getUserAndProfile();
  if (!session) redirect("/login");

  return (
    <div style={{ minHeight: "100vh", background: "#f6f7f8" }}>
      <header
        style={{
          background: "#fff",
          borderBottom: "1px solid #e3e5e8",
          padding: "0.7rem 1rem",
          display: "flex",
          alignItems: "center",
          gap: "0.75rem",
        }}
      >
        <Link
          href="/dashboard"
          style={{ fontWeight: 700, fontSize: "1.05rem", color: "#123", textDecoration: "none" }}
        >
          📹 Tassana AI
        </Link>
        <span style={{ marginLeft: "auto", color: "#667", fontSize: "0.85rem" }}>
          {session.profile.display_name ?? session.user.email}
        </span>
        <form action={signOut} style={{ margin: 0 }}>
          <button
            style={{
              fontSize: "0.85rem",
              padding: "0.35rem 0.75rem",
              border: "1px solid #ccd0d5",
              borderRadius: 8,
              background: "#fff",
              cursor: "pointer",
            }}
          >
            ออกจากระบบ
          </button>
        </form>
      </header>
      <div style={{ maxWidth: 960, margin: "0 auto", padding: "1.25rem 1rem" }}>
        {children}
      </div>
    </div>
  );
}
