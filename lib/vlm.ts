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
  // ADR-013: the model may admit uncertainty and ask the humans instead.
  uncertain: boolean;
  question_th: string | null;
}

export class VlmError extends Error {}
export class VlmTimeoutError extends VlmError {}
export class VlmRateLimitError extends VlmError {}

export interface SnapshotContext {
  eventType: string;
  cameraName: string;
  siteName: string;
  // Layer 2 (ADR-011): role profile of this camera — a database row, not code.
  profileName?: string | null;
  profilePrompt?: string | null;
  // Layer 3 (ADR-011): plain-Thai instructions typed by admins/customers.
  siteInstructions?: string | null;
  cameraInstructions?: string | null;
  // Schedule context: the same rule at 2 AM and 2 PM should not sound the same.
  strictHours?: { start: string; end: string } | null;
  nowBangkok?: string; // "HH:mm", injectable for tests
  // Layer 4 (ADR-013): facts humans have taught this site.
  knowledge?: string[];
  // Layer 5 (ADR-014): the system's own learned sense of "normal" here, plus
  // recent verdicts humans marked as false alarms.
  baseline?: string | null;
  falseAlarmExamples?: string[];
}

// Layer 1 (ADR-011): universal watch list. Every camera, cannot be disabled.
const BASE_WATCH_TH = [
  "กล้องถูกบัง ถูกหันทิศผิดไป หรือภาพมืด/เบลอผิดปกติ (คนร้ายมักจัดการกล้องก่อน)",
  "คนล้มแล้วไม่ลุก หรือท่าทางบาดเจ็บ/หมดสติ",
  "ควันหรือเปลวไฟ",
  "การชุลมุน ทะเลาะวิวาท หรือทำร้ายร่างกาย",
  "รถชนหรืออุบัติเหตุ",
].join(", ");

export function isWithinStrictHours(
  now: string,
  start: string,
  end: string,
): boolean {
  // Overnight windows (e.g. 22:00–06:00) wrap past midnight.
  if (start <= end) return now >= start && now < end;
  return now >= start || now < end;
}

export function buildPrompt(ctx: SnapshotContext): string {
  const isPatrol = /patrol/i.test(ctx.eventType) || ctx.eventType === "night_patrol";
  const lines = [
    "คุณเป็นผู้ช่วยเจ้าหน้าที่รักษาความปลอดภัยหมู่บ้าน/คอนโดในประเทศไทย",
    isPatrol
      ? `ภาพนี้คือ "การเดินตรวจเวร" ตามเวลาจากกล้อง "${ctx.cameraName}" ของ "${ctx.siteName}" — ไม่ได้เกิดจากความเคลื่อนไหว ให้ประเมิน "สภาพ" ของพื้นที่: มีคนค้างอยู่ไหม ไฟ/แอร์/จอเปิดทิ้งไว้ไหม ประตูหน้าต่างปิดเรียบร้อยไหม มีอะไรผิดที่ผิดทางไหม ถ้าเรียบร้อยทุกอย่างให้ verified=true severity=info และบอกว่า "ปิดเรียบร้อย"`
      : `ภาพนี้มาจากกล้อง "${ctx.cameraName}" ของ "${ctx.siteName}" ระบบตรวจจับแจ้งประเภทเหตุการณ์เบื้องต้นว่า "${ctx.eventType}"`,
    `สิ่งที่ต้องเฝ้าระวังเสมอไม่ว่ากล้องทำหน้าที่อะไร (พบเมื่อไหร่ให้ verified=true และ severity อย่างน้อย warning): ${BASE_WATCH_TH}`,
  ];

  if (ctx.profilePrompt) {
    lines.push(
      `หน้าที่เฉพาะของกล้องนี้${ctx.profileName ? ` (${ctx.profileName})` : ""}: ${ctx.profilePrompt}`,
    );
  }

  if (ctx.nowBangkok) {
    if (ctx.strictHours) {
      const inStrict = isWithinStrictHours(
        ctx.nowBangkok,
        ctx.strictHours.start,
        ctx.strictHours.end,
      );
      lines.push(
        inStrict
          ? `ขณะนี้เวลา ${ctx.nowBangkok} น. อยู่ในช่วงเฝ้าระวังเข้มข้น (${ctx.strictHours.start}–${ctx.strictHours.end}) — กิจกรรมของคนในช่วงนี้ให้ถือว่าน่าสงสัยกว่าปกติและยกระดับ severity ขึ้น`
          : `ขณะนี้เวลา ${ctx.nowBangkok} น. เป็นช่วงเวลาปกติ`,
      );
    } else {
      lines.push(`ขณะนี้เวลา ${ctx.nowBangkok} น.`);
    }
  }

  if (ctx.knowledge && ctx.knowledge.length > 0) {
    lines.push(
      `ความรู้เฉพาะไซต์นี้ที่ผู้ดูแลเคยสอนไว้: ${ctx.knowledge.map((k) => `"${k}"`).join(" / ")}`,
      // Taught facts reduce noise; they must never silence the layer-1 list.
      "กติกาการใช้ความรู้: ใช้เพื่อแยกแยะสิ่งที่เป็นเรื่องปกติของไซต์และบรรยายได้แม่นขึ้นเท่านั้น ห้ามใช้เป็นเหตุยกเลิกการแจ้งรายการเฝ้าระวังเสมอเด็ดขาด — ต่อให้รู้จักบุคคล/สัตว์/รถในภาพ ถ้ามีการปีนรั้ว บุกรุก ล้มไม่ลุก ควัน/ไฟ หรือทะเลาะวิวาท ต้อง verified=true เสมอ และหากความรู้ขัดแย้งกับสิ่งที่เห็นชัดเจนในภาพ ให้เชื่อภาพ",
    );
  }

  if (ctx.baseline) {
    lines.push(
      `สิ่งที่ระบบเรียนรู้เองว่าเป็น "ภาพปกติ" ของกล้องนี้จากการเฝ้าดูที่ผ่านมา: ${ctx.baseline}`,
      "ใช้ความปกติที่เรียนรู้นี้เพื่อไม่ยกเรื่องธรรมดาซ้ำ ๆ ขึ้นมาเป็นเหตุน่าสงสัย และบรรยายให้กระชับ — แต่กติกาเดิมยังบังคับ: รายการเฝ้าระวังเสมอไม่มีวันถูกความปกติกลบ และสิ่งที่ต่างจากความปกติอย่างชัดเจน (คน/รถ/ของ ที่ไม่เคยมี, เวลาที่ไม่ควรมี) คือสิ่งที่ควรยกขึ้นมา",
    );
  }
  if (ctx.falseAlarmExamples && ctx.falseAlarmExamples.length > 0) {
    lines.push(
      `ตัวอย่างการตัดสินของกล้องนี้ที่ผู้ดูแลเคยบอกว่า "แจ้งเท็จ" (อย่าทำซ้ำแบบเดียวกัน): ${ctx.falseAlarmExamples.map((e) => `"${e}"`).join(" / ")}`,
    );
  }

  const instructions = [ctx.siteInstructions, ctx.cameraInstructions]
    .map((s) => s?.trim())
    .filter((s): s is string => !!s);
  if (instructions.length > 0) {
    lines.push(
      `คำสั่งเพิ่มเติมจากผู้ดูแล (ให้ความสำคัญสูง หากภาพเข้าเงื่อนไขเหล่านี้ต้องระบุในคำบรรยายเสมอ): ${instructions.join(" / ")}`,
    );
  }

  lines.push(
    "วิเคราะห์ภาพแล้วตอบเป็น JSON เท่านั้น ตาม schema นี้:",
    '{"verified": boolean, "severity": "info"|"warning"|"critical", "description_th": string, "label": string|null, "uncertain": boolean, "question_th": string|null}',
    "- uncertain: true เฉพาะเมื่อคุณเห็นสิ่งที่ระบุไม่ได้หรือไม่แน่ใจว่าควรแจ้งเตือนไหม และความรู้ที่มีอยู่ตอบไม่ได้ — พร้อมตั้ง question_th เป็นคำถามสั้น ๆ ภาษาไทยถามผู้ดูแล (เช่น \"วัตถุสีส้มใกล้รั้วคืออะไรครับ อันตรายไหม\") ถ้ามั่นใจให้ uncertain=false และ question_th=null",
    "- verified: true ถ้าเห็นเหตุการณ์ที่ควรสนใจจริง (คน/รถ/การบุกรุก/สิ่งที่คำสั่งผู้ดูแลระบุ), false ถ้าเป็นการแจ้งเตือนหลอก (เงา แสง ฝน สัตว์เล็ก ต้นไม้ไหว)",
    "- severity: critical = อันตราย/บุกรุกชัดเจนหรือเหตุในรายการเฝ้าระวังเสมอ, warning = ควรให้เจ้าหน้าที่ตรวจสอบ, info = กิจกรรมปกติ",
    "- description_th: บรรยายสั้น 1 ประโยคภาษาไทย เจาะจงสิ่งที่เห็น เช่น จำนวนคน การแต่งกาย ทิศทางการเคลื่อนไหว",
    '- label: สิ่งหลักที่ตรวจพบเป็นอังกฤษ เช่น "person", "car", "motorcycle", "dog" หรือ null ถ้าไม่มี',
  );
  return lines.join("\n");
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
    uncertain: parsed.uncertain === true,
    question_th:
      typeof parsed.question_th === "string" && parsed.question_th.trim() !== ""
        ? parsed.question_th
        : null,
  };
}

// ADR-014: distill many "normal" descriptions into one baseline paragraph.
// Text-only call — cheap, and it runs once a day per camera.
export async function summarizeBaseline(
  cameraName: string,
  profileName: string | null,
  descriptions: string[],
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new VlmError("GEMINI_API_KEY is not set");
  const model = process.env.GEMINI_MODEL ?? "gemini-flash-lite-latest";
  const prompt = [
    `ต่อไปนี้คือคำบรรยายภาพจากกล้อง "${cameraName}"${profileName ? ` (หน้าที่: ${profileName})` : ""} ที่ระบบตัดสินว่า "ปกติ" ในช่วง 7 วันที่ผ่านมา จำนวน ${descriptions.length} รายการ:`,
    ...descriptions.map((d, i) => `${i + 1}. ${d}`),
    "",
    "สรุปเป็นย่อหน้าเดียวภาษาไทย ไม่เกิน 4 ประโยค ว่า \"ภาพปกติของกล้องนี้คืออะไร\": ใครมักปรากฏ (จำนวนคน/ลักษณะ), ทำอะไรบ่อย, มีวัตถุ/รถอะไรประจำ, ช่วงเวลาไหนคึกหรือเงียบ — เขียนแบบเจ้าหน้าที่สรุปให้ รปภ. คนใหม่ฟัง ไม่ต้องขึ้นต้นด้วยคำว่าสรุป ตอบเป็นข้อความธรรมดาเท่านั้น",
  ].join("\n");

  let response: Response;
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2 },
        }),
        signal: AbortSignal.timeout(VLM_TIMEOUT_MS),
      },
    );
  } catch (err) {
    throw new VlmError(`baseline request failed: ${(err as Error).message}`);
  }
  if (!response.ok) {
    if (response.status === 429) throw new VlmRateLimitError("baseline rate limited");
    throw new VlmError(`baseline HTTP ${response.status}`);
  }
  const data = (await response.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!text) throw new VlmError("baseline: empty response");
  return text.slice(0, 900);
}

export async function analyzeSnapshot(
  imageBase64: string,
  mimeType: string,
  ctx: SnapshotContext,
  modelOverride?: string,
): Promise<VlmAnalysis> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new VlmError("GEMINI_API_KEY is not set");
  // Free-tier reality: lite has the roomier quota, so it leads; the bigger
  // flash is the fallback. Swap via GEMINI_MODEL env when billing arrives.
  const model =
    modelOverride ?? process.env.GEMINI_MODEL ?? "gemini-flash-lite-latest";

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
    if (response.status === 429) {
      // Free-tier RPM/TPM throttle — caller may fall back to another model.
      throw new VlmRateLimitError(`VLM rate limited: ${body.slice(0, 200)}`);
    }
    throw new VlmError(`VLM HTTP ${response.status}: ${body.slice(0, 300)}`);
  }

  const data = (await response.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new VlmError("VLM returned no text candidate");
  return parseAnalysis(text, model);
}
