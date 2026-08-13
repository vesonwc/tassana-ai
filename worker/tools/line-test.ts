import { createClient } from "@supabase/supabase-js";
import { buildAlertFlex, pushLineMessage } from "../../lib/line";
import { TYPE_TH } from "../../lib/labels";
import type { EventType, Severity } from "../../lib/types";

// Send a real alert (latest analyzed event with a snapshot) to a LINE target.
// Usage: npx tsx worker/tools/line-test.ts <U.../C...>

try {
  process.loadEnvFile(".env");
} catch {
  // optional
}

const to = process.argv[2];
if (!to) {
  console.error("usage: npx tsx worker/tools/line-test.ts <line-user-or-group-id>");
  process.exit(1);
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

async function main(): Promise<void> {
  const { data: rows } = await supabase
    .from("events")
    .select("event_id, site_id, event_type, occurred_at, media, ai, cameras(name), sites(name)")
    .not("media->>snapshot_path", "is", null)
    .not("ai->>description_th", "is", null)
    .order("received_at", { ascending: false })
    .limit(1);
  const ev = rows?.[0] as unknown as {
    event_id: string;
    site_id: string;
    event_type: string;
    occurred_at: string;
    media: { snapshot_path: string };
    ai: { severity: string | null; description_th: string };
    cameras: { name: string } | null;
    sites: { name: string } | null;
  } | undefined;
  if (!ev) {
    console.error("no analyzed event with snapshot found");
    process.exit(1);
  }

  const { data: signed } = await supabase.storage
    .from("snapshots")
    .createSignedUrl(ev.media.snapshot_path, 86_400);

  const flex = buildAlertFlex({
    severity: (ev.ai.severity ?? "info") as Severity,
    eventTypeTh: TYPE_TH[ev.event_type as EventType] ?? ev.event_type,
    descriptionTh: `${ev.ai.description_th} (ข้อความทดสอบระบบ)`,
    cameraName: ev.cameras?.name ?? "ไม่ระบุกล้อง",
    siteName: ev.sites?.name ?? "",
    timeTh: `${new Date(ev.occurred_at).toLocaleTimeString("th-TH", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit" })} น.`,
    imageUrl: signed?.signedUrl ?? null,
    dashboardUrl: `${process.env.NEXT_PUBLIC_APP_URL ?? "https://tassana-ai.vercel.app"}/dashboard/sites/${ev.site_id}`,
  });

  const result = await pushLineMessage(to, [flex]);
  console.log(result.ok ? "✅ LINE alert sent" : `❌ ${result.error}`);
}

void main();
