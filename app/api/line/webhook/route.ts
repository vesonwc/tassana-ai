import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { replyLineMessage } from "@/lib/line";

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
    events?: {
      type?: string;
      replyToken?: string;
      message?: { type?: string; text?: string };
      source?: { type?: string; groupId?: string; roomId?: string; userId?: string };
    }[];
  };
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: true });
  }

  const ev = payload.events?.[0];
  const source = ev?.source;
  const chatId = source?.groupId ?? source?.roomId ?? source?.userId;
  if (!chatId) return NextResponse.json({ ok: true });

  const supabase = getServiceClient();
  await supabase.from("system_status").upsert({
    key: "line_last_source",
    value: { id: chatId, type: source?.type ?? "unknown" },
    updated_at: new Date().toISOString(),
  });

  // Teach-by-reply (ADR-013): a text message answers the latest open question
  // from this chat and becomes permanent site knowledge.
  const text = ev?.type === "message" && ev.message?.type === "text"
    ? (ev.message.text ?? "").trim()
    : "";
  if (text && ev?.replyToken) {
    const cutoff = new Date(Date.now() - 48 * 3_600_000).toISOString();
    const { data: pending } = await supabase
      .from("pending_questions")
      .select("id, site_id, event_id, question_th")
      .eq("line_target", chatId)
      .is("answered_at", null)
      .gte("created_at", cutoff)
      .order("created_at", { ascending: false })
      .limit(1);
    const question = pending?.[0];
    if (question) {
      const { data: eventRow } = await supabase
        .from("events")
        .select("camera_id")
        .eq("event_id", question.event_id)
        .maybeSingle();
      await supabase.from("site_knowledge").insert({
        site_id: question.site_id,
        camera_id: eventRow?.camera_id ?? null,
        fact_th: text,
        source: "line_reply",
      });
      await supabase
        .from("pending_questions")
        .update({ answered_at: new Date().toISOString() })
        .eq("id", question.id);
      await replyLineMessage(ev.replyToken, [
        {
          type: "text",
          text: `รับทราบครับ ✅ บันทึกความรู้แล้ว:\n"${text}"\n\nระบบจะใช้ข้อมูลนี้ประกอบการวิเคราะห์ทุกครั้งต่อจากนี้ (ดู/แก้ได้ที่แท็บ 🧠 ในหน้าตั้งค่า)`,
        },
      ]);
    }
  }

  return NextResponse.json({ ok: true });
}
