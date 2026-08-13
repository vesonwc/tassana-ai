import type { Severity } from "@/lib/types";

// LINE Messaging API sender (M2). The only delivery pipe for now — keep the
// message-building pure so another channel can reuse it later.

const LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push";

export interface AlertPayload {
  severity: Severity;
  eventTypeTh: string;
  descriptionTh: string;
  cameraName: string;
  siteName: string;
  timeTh: string; // "02:14 น."
  imageUrl: string | null; // https signed URL
  dashboardUrl: string;
}

const SEVERITY_HEADER: Record<Severity, { emoji: string; label: string; color: string }> = {
  critical: { emoji: "🔴", label: "ฉุกเฉิน", color: "#C0392B" },
  warning: { emoji: "🟠", label: "ควรตรวจสอบ", color: "#B06000" },
  info: { emoji: "🟢", label: "แจ้งเพื่อทราบ", color: "#1A7F37" },
};

// Flex message: image on top, severity headline, AI description, footer button.
export function buildAlertFlex(a: AlertPayload): Record<string, unknown> {
  const head = SEVERITY_HEADER[a.severity];
  const body: Record<string, unknown>[] = [
    {
      type: "text",
      text: `${head.emoji} ${head.label} — ${a.eventTypeTh}`,
      weight: "bold",
      size: "md",
      color: head.color,
      wrap: true,
    },
    { type: "text", text: a.descriptionTh, size: "sm", wrap: true, margin: "sm" },
    {
      type: "text",
      text: `📷 ${a.cameraName} · ${a.siteName} · ${a.timeTh}`,
      size: "xs",
      color: "#9E9E9E",
      margin: "sm",
      wrap: true,
    },
  ];
  const bubble: Record<string, unknown> = {
    type: "bubble",
    body: { type: "box", layout: "vertical", contents: body },
    footer: {
      type: "box",
      layout: "horizontal",
      contents: [
        {
          type: "button",
          style: "primary",
          color: "#1D1D1F",
          height: "sm",
          action: { type: "uri", label: "ดูในระบบ", uri: a.dashboardUrl },
        },
      ],
    },
  };
  if (a.imageUrl) {
    bubble.hero = {
      type: "image",
      url: a.imageUrl,
      size: "full",
      aspectRatio: "16:9",
      aspectMode: "cover",
    };
  }
  return {
    type: "flex",
    altText: `${head.emoji} ${a.eventTypeTh}: ${a.descriptionTh}`,
    contents: bubble,
  };
}

export async function pushLineMessage(
  to: string,
  messages: Record<string, unknown>[],
): Promise<{ ok: boolean; error?: string }> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) return { ok: false, error: "LINE_CHANNEL_ACCESS_TOKEN is not set" };
  try {
    const response = await fetch(LINE_PUSH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ to, messages }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const body = await response.text();
      return { ok: false, error: `LINE HTTP ${response.status}: ${body.slice(0, 300)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// Reply within LINE's reply-token window (free, does not count as push).
export async function replyLineMessage(
  replyToken: string,
  messages: Record<string, unknown>[],
): Promise<{ ok: boolean; error?: string }> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) return { ok: false, error: "LINE_CHANNEL_ACCESS_TOKEN is not set" };
  try {
    const response = await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ replyToken, messages }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const body = await response.text();
      return { ok: false, error: `LINE reply HTTP ${response.status}: ${body.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export function buildDailyReportText(stats: {
  siteName: string;
  dateTh: string;
  total: number;
  abnormalLines: string[];
  vehicles: number;
  camerasOnline: string; // "8/8"
  offlineIncidents: number;
  reportUrl: string;
}): string {
  const lines = [
    `☀️ รายงานประจำวัน — ${stats.siteName}`,
    `${stats.dateTh} (สรุปข้อมูลเมื่อวาน)`,
    "",
    stats.abnormalLines.length === 0
      ? "เมื่อวานโดยรวมเรียบร้อยดี ไม่มีเหตุผิดปกติ"
      : `เมื่อวานมีเหตุควรทราบ ${stats.abnormalLines.length} รายการ`,
    `• เหตุการณ์ทั้งหมด ${stats.total} รายการ`,
    ...stats.abnormalLines.map((l) => `• 🔴 ${l}`),
    `• 🚗 ยานพาหนะเข้า-ออก ${stats.vehicles} ครั้ง`,
    stats.offlineIncidents > 0
      ? `• ⚠️ กล้องขาดการติดต่อ ${stats.offlineIncidents} ครั้ง`
      : `• 📷 กล้องออนไลน์ ${stats.camerasOnline} ตลอดวัน`,
    "",
    `ดูรายละเอียด: ${stats.reportUrl}`,
  ];
  return lines.join("\n");
}
