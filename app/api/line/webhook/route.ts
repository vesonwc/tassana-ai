import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export const runtime = "nodejs";

// LINE webhook: we mainly use it to discover chat IDs — add the bot to a group,
// send any message, and the group's ID appears in settings ready to copy.
export async function POST(request: Request) {
  const raw = await request.text();

  const secret = process.env.LINE_CHANNEL_SECRET;
  if (secret) {
    const signature = request.headers.get("x-line-signature") ?? "";
    const expected = createHmac("sha256", secret).update(raw).digest("base64");
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return NextResponse.json({ error: "bad signature" }, { status: 401 });
    }
  }

  let payload: {
    events?: { source?: { type?: string; groupId?: string; roomId?: string; userId?: string } }[];
  };
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: true });
  }

  const source = payload.events?.[0]?.source;
  const chatId = source?.groupId ?? source?.roomId ?? source?.userId;
  if (chatId) {
    const supabase = getServiceClient();
    await supabase.from("system_status").upsert({
      key: "line_last_source",
      value: { id: chatId, type: source?.type ?? "unknown" },
      updated_at: new Date().toISOString(),
    });
  }
  return NextResponse.json({ ok: true });
}
