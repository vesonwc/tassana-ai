export default function HomePage() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "0.75rem",
        padding: "2rem",
        textAlign: "center",
      }}
    >
      <h1 style={{ margin: 0 }}>Tassana AI</h1>
      <p style={{ margin: 0, color: "#555" }}>
        แพลตฟอร์มเฝ้าระวังอัจฉริยะ — รับ event จากกล้อง/NVR เดิม กรองด้วย AI
        แจ้งเตือนผ่าน LINE
      </p>
      <p style={{ margin: 0, fontSize: "0.9rem", color: "#999" }}>
        ระบบอยู่ระหว่างพัฒนา (MVP)
      </p>
      <a
        href="/login"
        style={{
          marginTop: "0.75rem",
          padding: "0.6rem 1.5rem",
          background: "#1a7f37",
          color: "#fff",
          borderRadius: 8,
          textDecoration: "none",
          fontWeight: 600,
        }}
      >
        เข้าสู่ระบบ
      </a>
    </main>
  );
}
