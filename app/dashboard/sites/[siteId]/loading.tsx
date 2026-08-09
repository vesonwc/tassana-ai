export default function SiteLoading() {
  const row = {
    background: "#fff",
    borderRadius: 16,
    height: 96,
    opacity: 0.6,
    marginBottom: "0.7rem",
  } as const;
  return (
    <main>
      <div style={{ width: 220, height: 24, background: "#e8eaec", borderRadius: 8, marginBottom: 14 }} />
      <div style={{ width: 320, height: 34, background: "#eef0f2", borderRadius: 8, marginBottom: 14 }} />
      <div style={row} />
      <div style={row} />
      <div style={row} />
    </main>
  );
}
