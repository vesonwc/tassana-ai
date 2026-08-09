import type { Severity } from "@/lib/types";

// Gemini VLM client (REST, no SDK). Called by the worker only.
// Hard rule (ADR-005): never let a slow/failed VLM block or silence an alert —
// callers must treat VlmTimeoutError/VlmError as "send raw alert now".

export const VLM_TIMEOUT_MS = 20_000;

export interface VlmAnalysis {
  verified: boolean;
  severity: Severity;
  description_th: string;
  label: string | null;
  model: string;
}

export class VlmError extends Error {}
export class VlmTimeoutError extends VlmError {}

export interface SnapshotContext {
  eventType: string;
  cameraName: string;
  siteName: string;
}

function buildPrompt(ctx: SnapshotContext): string {
  return [
    "คุณเป็นผู้ช่วยเจ้าหน้าที่รักษาความปลอดภัยหมู่บ้าน/คอนโดในประเทศไทย",
    `ภาพนี้มาจากกล้อง "${ctx.cameraName}" ของ "${ctx.siteName}" ระบบตรวจจับแจ้งประเภทเหตุการณ์เบื้องต้นว่า "${ctx.eventType}"`,
    "วิเคราะห์ภาพแล้วตอบเป็น JSON เท่านั้น ตาม schema นี้:",
    '{"verified": boolean, "severity": "info"|"warning"|"critical", "description_th": string, "label": string|null}',
    "- verified: true ถ้าเห็นเหตุการณ์ที่ควรสนใจจริง (คน/รถ/การบุกรุก), false ถ้าเป็นการแจ้งเตือนหลอก (เงา แสง ฝน สัตว์เล็ก ต้นไม้ไหว)",
    "- severity: critical = คนปีนรั้ว/งัดแงะ/พฤติกรรมน่าสงสัยชัดเจน, warning = คน/รถแปลกปลอมที่ควรตรวจสอบ, info = กิจกรรมปกติ",
    "- description_th: บรรยายสั้น 1 ประโยคภาษาไทย เจาะจงสิ่งที่เห็น เช่น จำนวนคน การแต่งกาย ทิศทางการเคลื่อนไหว",
    '- label: สิ่งหลักที่ตรวจพบเป็นอังกฤษ เช่น "person", "car", "motorcycle", "dog" หรือ null ถ้าไม่มี',
  ].join("\n");
}

function parseAnalysis(text: string, model: string): VlmAnalysis {
  const cleaned = text.replace(/```json|```/g, "").trim();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    throw new VlmError(`unparseable VLM response: ${text.slice(0, 200)}`);
  }
  const severity: Severity =
    parsed.severity === "critical" || parsed.severity === "warning"
      ? parsed.severity
      : "info";
  return {
    verified: parsed.verified === true,
    severity,
    description_th:
      typeof parsed.description_th === "string" ? parsed.description_th : "",
    label: typeof parsed.label === "string" ? parsed.label : null,
    model,
  };
}

export async function analyzeSnapshot(
  imageBase64: string,
  mimeType: string,
  ctx: SnapshotContext,
): Promise<VlmAnalysis> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new VlmError("GEMINI_API_KEY is not set");
  const model = process.env.GEMINI_MODEL ?? "gemini-flash-latest";

  let response: Response;
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { inline_data: { mime_type: mimeType, data: imageBase64 } },
                { text: buildPrompt(ctx) },
              ],
            },
          ],
          generationConfig: {
            response_mime_type: "application/json",
            temperature: 0.2,
          },
        }),
        signal: AbortSignal.timeout(VLM_TIMEOUT_MS),
      },
    );
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new VlmTimeoutError(`VLM timed out after ${VLM_TIMEOUT_MS}ms`);
    }
    throw new VlmError(`VLM request failed: ${(err as Error).message}`);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new VlmError(`VLM HTTP ${response.status}: ${body.slice(0, 300)}`);
  }

  const data = (await response.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new VlmError("VLM returned no text candidate");
  return parseAnalysis(text, model);
}
