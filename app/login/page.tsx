import { signIn } from "./actions";

export const metadata = { title: "เข้าสู่ระบบ — Tassana AI" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1.5rem",
        background: "#f6f7f8",
      }}
    >
      <form
        action={signIn}
        style={{
          width: "100%",
          maxWidth: 360,
          background: "#fff",
          border: "1px solid #e3e5e8",
          borderRadius: 12,
          padding: "2rem 1.75rem",
          display: "flex",
          flexDirection: "column",
          gap: "0.9rem",
        }}
      >
        <div style={{ textAlign: "center", marginBottom: "0.5rem" }}>
          <div style={{ fontSize: "2rem" }}>📹</div>
          <h1 style={{ margin: "0.25rem 0 0", fontSize: "1.35rem" }}>Tassana AI</h1>
          <p style={{ margin: 0, color: "#667", fontSize: "0.9rem" }}>
            ระบบเฝ้าระวังอัจฉริยะ
          </p>
        </div>

        {error && (
          <p
            style={{
              margin: 0,
              background: "#fdecec",
              color: "#a33",
              padding: "0.5rem 0.75rem",
              borderRadius: 8,
              fontSize: "0.9rem",
            }}
          >
            อีเมลหรือรหัสผ่านไม่ถูกต้อง ลองใหม่อีกครั้ง
          </p>
        )}

        <label style={{ fontSize: "0.9rem", color: "#334" }}>
          อีเมล
          <input
            name="email"
            type="email"
            required
            autoComplete="email"
            placeholder="name@example.com"
            style={{
              width: "100%",
              marginTop: 4,
              padding: "0.6rem 0.75rem",
              fontSize: "1rem",
              border: "1px solid #ccd0d5",
              borderRadius: 8,
              boxSizing: "border-box",
            }}
          />
        </label>

        <label style={{ fontSize: "0.9rem", color: "#334" }}>
          รหัสผ่าน
          <input
            name="password"
            type="password"
            required
            autoComplete="current-password"
            style={{
              width: "100%",
              marginTop: 4,
              padding: "0.6rem 0.75rem",
              fontSize: "1rem",
              border: "1px solid #ccd0d5",
              borderRadius: 8,
              boxSizing: "border-box",
            }}
          />
        </label>

        <button
          type="submit"
          style={{
            marginTop: "0.5rem",
            padding: "0.7rem",
            fontSize: "1rem",
            fontWeight: 600,
            color: "#fff",
            background: "#1a7f37",
            border: "none",
            borderRadius: 8,
            cursor: "pointer",
          }}
        >
          เข้าสู่ระบบ
        </button>

        <p style={{ margin: 0, textAlign: "center", color: "#889", fontSize: "0.8rem" }}>
          ยังไม่มีบัญชี? ติดต่อทีมงาน Tassana AI
        </p>
      </form>
    </main>
  );
}
