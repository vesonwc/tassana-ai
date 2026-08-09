// Instant skeleton while server data loads — the click feels immediate.
export default function DashboardLoading() {
  const card = {
    background: "#fff",
    borderRadius: 16,
    height: 110,
    opacity: 0.6,
  } as const;
  return (
    <main>
      <div style={{ width: 180, height: 26, background: "#e8eaec", borderRadius: 8, marginBottom: 8 }} />
      <div style={{ width: 240, height: 14, background: "#eef0f2", borderRadius: 6, marginBottom: 16 }} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: "0.9rem" }}>
        <div style={card} />
        <div style={card} />
        <div style={card} />
      </div>
    </main>
  );
}
