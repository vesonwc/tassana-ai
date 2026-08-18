import { createClient } from "@supabase/supabase-js";
import { v7 as uuidv7 } from "uuid";
import {
  analyzeSnapshot,
  summarizeBaseline,
  VlmRateLimitError,
  VlmTimeoutError,
  type SnapshotContext,
  type VlmAnalysis,
  type VlmAttachment,
} from "../lib/vlm";
import type { AiResult, DetectorSummary, EventType, Severity } from "../lib/types";
import { buildDetectorHint, decideGate, normalizeBox, summarizeLabels } from "../lib/detector-core";
import { cropForVlm, detectObjects, detectorDisabledReason, detectorReady, DETECTOR_MODE, MODEL_PATH, warmDetector } from "./detector";
import { buildAlertFlex, buildDailyReportText, pushLineMessage } from "../lib/line";
import { TYPE_TH } from "../lib/labels";

// Queue worker (M3): pgmq "events" → load snapshot → Gemini → update events.ai.
// Fail-open (ADR-005): VLM timeout/failure never blocks the pipeline — the
// event row already exists and is visible; we record the miss and move on.
// LINE delivery (M2, postponed) will hook in after the analyze step.

try {
  process.loadEnvFile(".env");
} catch {
  // .env is optional when env vars come from the platform (Railway)
}

const POLL_INTERVAL_MS = 3_000;
const MAX_ATTEMPTS = 5;
// Free-tier Gemini allows ~10 requests/min — space calls out so queue bursts
// (several cameras firing at once) do not trip 429s.
const VLM_MIN_INTERVAL_MS = Number(process.env.VLM_MIN_INTERVAL_MS ?? 7_000);
// Separate model = separate free-tier quota bucket; used when primary is 429ing.
const VLM_FALLBACK_MODEL =
  process.env.GEMINI_FALLBACK_MODEL ?? "gemini-flash-latest";
const HEARTBEAT_CHECK_MS = 60_000;
// ADR-015: model tag for events settled by the detector gate (no VLM call).
const DETECTOR_GATE_MODEL = "detector-gate";
const HEARTBEAT_TIMEOUT_MIN = Number(process.env.HEARTBEAT_TIMEOUT_MIN ?? 10);

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("worker: missing Supabase env vars, exiting");
  process.exit(1);
}
const supabase = createClient(url, key, { auth: { persistSession: false } });

interface QueueMessage {
  msg_id: number;
  read_ct: number;
  message: { event_id?: string };
}

interface SiteRules {
  strict_hours?: { start: string; end: string };
  alerts?: Record<string, boolean>;
  sensitivity?: string;
  retention_days?: number;
}

interface EventRow {
  event_id: string;
  site_id: string;
  camera_id: string | null;
  event_type: string;
  occurred_at: string;
  media: { snapshot_path: string | null };
  ai: AiResult;
  cameras: {
    name: string;
    enabled: boolean;
    custom_instructions_th: string | null;
    camera_profiles: { name_th: string; vlm_prompt_th: string } | null;
  } | null;
  sites: {
    name: string;
    line_group_id: string | null;
    custom_instructions_th: string | null;
    rules: SiteRules | null;
  } | null;
}

const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ?? "https://tassana-ai.vercel.app";

// sensitivity (ADR-010 rules) → minimum severity that reaches LINE.
function severityPasses(sensitivity: string | undefined, severity: Severity): boolean {
  if (sensitivity === "low") return severity === "critical";
  if (sensitivity === "high") return true;
  return severity === "critical" || severity === "warning";
}

function bangkokNowHHmm(): string {
  return new Date().toLocaleTimeString("en-GB", {
    timeZone: "Asia/Bangkok",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ack(msgId: number): Promise<void> {
  const { error } = await supabase.rpc("ack_event", { p_msg_id: msgId });
  if (error) console.error(`worker: ack ${msgId} failed`, error.message);
}

async function updateAi(eventId: string, ai: AiResult): Promise<void> {
  const { error } = await supabase
    .from("events")
    .update({ ai })
    .eq("event_id", eventId);
  if (error) throw new Error(`update ai failed: ${error.message}`);
}

let lastVlmCallAt = 0;
async function vlmThrottle(): Promise<void> {
  const wait = lastVlmCallAt + VLM_MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastVlmCallAt = Date.now();
}

async function analyzeWithFallback(
  base64: string,
  mime: string,
  ctx: SnapshotContext,
  attachments: VlmAttachment[] = [],
): Promise<VlmAnalysis> {
  await vlmThrottle();
  try {
    return await analyzeSnapshot(base64, mime, ctx, undefined, attachments);
  } catch (err) {
    if (!(err instanceof VlmRateLimitError)) throw err;
    console.warn(`worker: primary model rate-limited, trying ${VLM_FALLBACK_MODEL}`);
    await vlmThrottle();
    return analyzeSnapshot(base64, mime, ctx, VLM_FALLBACK_MODEL, attachments);
  }
}

// ADR-015: run the object detector first. Never throws — a broken detector
// simply yields { detector: null } and the VLM sees the plain frame.
async function runDetectorStage(
  row: EventRow,
  buffer: Buffer,
  rawType: string,
): Promise<{
  detector: DetectorSummary | null;
  skip: boolean;
  hint: string | null;
  attachments: VlmAttachment[];
}> {
  const none = { detector: null, skip: false, hint: null, attachments: [] };
  if (DETECTOR_MODE === "off") return none;
  let run: Awaited<ReturnType<typeof detectObjects>> = null;
  try {
    run = await detectObjects(buffer);
  } catch (err) {
    console.warn(`worker: detector threw — fail open: ${(err as Error).message}`);
  }
  if (!run) {
    console.warn(`worker: detector unavailable (${detectorDisabledReason() ?? "timeout"}) — fail open`);
    return none;
  }
  const gate = decideGate({
    mode: DETECTOR_MODE,
    eventType: row.event_type,
    rawEventType: rawType,
    detections: run.detections,
  });
  const detector: DetectorSummary = {
    model: run.model,
    mode: DETECTOR_MODE,
    ms: run.ms,
    objects: run.detections.slice(0, 10).map((d) => ({
      label: d.label,
      confidence: Math.round(d.confidence * 100) / 100,
      bbox: normalizeBox(d.box, run!.width, run!.height),
    })),
    gate: gate.action === "skip" ? "skip" : gate.wouldSkip ? "would-skip" : "analyze",
    reason: gate.reason,
  };
  console.log(
    `worker: detector ${row.event_id} ${summarizeLabels(run.detections)} ${run.ms}ms → ${detector.gate}`,
  );
  if (gate.action === "skip") return { detector, skip: true, hint: null, attachments: [] };

  const attachments: VlmAttachment[] = [];
  if (gate.relevant.length > 0) {
    const crop = await cropForVlm(buffer, run);
    if (crop) attachments.push({ base64: crop.base64, mimeType: crop.mimeType });
  }
  return { detector, skip: false, hint: buildDetectorHint(run.detections), attachments };
}

interface AnalyzeOutcome {
  analysis: VlmAnalysis | null;
  detector: DetectorSummary | null;
  gateSkipped: boolean;
}

async function analyzeEvent(row: EventRow): Promise<AnalyzeOutcome> {
  const snapshotPath = row.media?.snapshot_path;
  if (!snapshotPath) {
    console.log(`worker: ${row.event_id} has no snapshot, skipping analysis`);
    return { analysis: null, detector: null, gateSkipped: false };
  }
  const { data: blob, error } = await supabase.storage
    .from("snapshots")
    .download(snapshotPath);
  if (error || !blob) {
    throw new Error(`snapshot download failed: ${error?.message}`);
  }
  const buffer = Buffer.from(await blob.arrayBuffer());
  const base64 = buffer.toString("base64");
  const mime = blob.type || "image/jpeg";

  const rawType = String((row as unknown as { raw?: { eventType?: string } }).raw?.eventType ?? "");
  const stage = await runDetectorStage(row, buffer, rawType);
  if (stage.skip) return { analysis: null, detector: stage.detector, gateSkipped: true };

  // Layer 4 (ADR-013): everything humans have taught this site.
  const { data: knowledgeRows } = await supabase
    .from("site_knowledge")
    .select("fact_th, camera_id")
    .eq("site_id", row.site_id)
    .order("created_at", { ascending: false })
    .limit(50);
  const knowledge = (knowledgeRows ?? [])
    .filter((k) => !k.camera_id || k.camera_id === row.camera_id)
    .map((k) => k.fact_th);

  // Layer 5 (ADR-014): learned baseline + recent human "false alarm" verdicts.
  let baseline: string | null = null;
  let falseAlarmExamples: string[] = [];
  if (row.camera_id) {
    const { data: bl } = await supabase
      .from("camera_baselines")
      .select("baseline_th")
      .eq("camera_id", row.camera_id)
      .maybeSingle();
    baseline = bl?.baseline_th ?? null;

    const { data: fa } = await supabase
      .from("alerts")
      .select("events!inner(camera_id, ai)")
      .eq("feedback", "false_alarm")
      .eq("events.camera_id", row.camera_id)
      .order("feedback_at", { ascending: false })
      .limit(5);
    falseAlarmExamples = (fa ?? [])
      .map((r) => (r as unknown as { events: { ai: AiResult | null } }).events?.ai?.description_th)
      .filter((d): d is string => !!d)
      .map((d) => d.replace(/(\s*\(สืบเนื่องจากเหตุก่อนหน้า\))+$/g, "").slice(0, 120));
  }

  // Assemble the config layers (ADR-011/013/014/015) from data, not code.
  const analysis = await analyzeWithFallback(
    base64,
    mime,
    {
      knowledge,
      baseline,
      falseAlarmExamples,
      detectorHint: stage.hint,
      eventType: /patrol/i.test(rawType) ? "night_patrol" : row.event_type,
      cameraName: row.cameras?.name ?? "ไม่ระบุกล้อง",
      siteName: row.sites?.name ?? "ไม่ระบุไซต์",
      profileName: row.cameras?.camera_profiles?.name_th ?? null,
      profilePrompt: row.cameras?.camera_profiles?.vlm_prompt_th ?? null,
      siteInstructions: row.sites?.custom_instructions_th ?? null,
      cameraInstructions: row.cameras?.custom_instructions_th ?? null,
      strictHours: row.sites?.rules?.strict_hours ?? null,
      nowBangkok: bangkokNowHHmm(),
    },
    stage.attachments,
  );
  return { analysis, detector: stage.detector, gateSkipped: false };
}

async function handleMessage(msg: QueueMessage): Promise<void> {
  const eventId = msg.message?.event_id;
  if (!eventId) {
    console.error(`worker: msg ${msg.msg_id} has no event_id, dropping`);
    await ack(msg.msg_id);
    return;
  }

  const { data, error } = await supabase
    .from("events")
    .select(
      "event_id, site_id, camera_id, event_type, occurred_at, media, ai, raw, cameras(name, enabled, custom_instructions_th, camera_profiles(name_th, vlm_prompt_th)), sites(name, line_group_id, custom_instructions_th, rules)",
    )
    .eq("event_id", eventId)
    .maybeSingle();
  if (error) throw new Error(`event fetch failed: ${error.message}`);
  if (!data) {
    console.error(`worker: event ${eventId} not found, dropping`);
    await ack(msg.msg_id);
    return;
  }
  const row = data as unknown as EventRow;

  if (row.ai?.processed_at) {
    await ack(msg.msg_id);
    return;
  }

  // Busy-scene shortcut: if this camera was judged "ปกติ (info)" moments ago
  // for the same event type, inherit that verdict instead of paying for a
  // fresh look. Serious types always get analyzed.
  const SERIOUS = new Set(["intrusion", "line_crossing", "loitering", "camera_offline"]);
  const isPatrol = /patrol/i.test(String((row as unknown as { raw?: { eventType?: string } }).raw?.eventType ?? ""));
  if (row.camera_id && !SERIOUS.has(row.event_type) && !isPatrol) {
    const since = new Date(Date.now() - 10 * 60_000).toISOString();
    const { data: recent } = await supabase
      .from("events")
      .select("ai")
      .eq("camera_id", row.camera_id)
      .eq("event_type", row.event_type)
      .gte("occurred_at", since)
      .not("ai->>processed_at", "is", null)
      .neq("event_id", eventId)
      .order("occurred_at", { ascending: false })
      .limit(1);
    const prior = recent?.[0]?.ai as AiResult | undefined;
    // Only inherit from a *fresh* verdict, never from an inherited one — and
    // keep the wording clean (no stacking suffixes).
    const priorIsFresh = !!prior?.model && !prior.model.endsWith("+inherit");
    if (prior && priorIsFresh && prior.verified === true && prior.severity === "info" && prior.description_th) {
      await updateAi(eventId, {
        verified: true,
        severity: "info",
        description_th: prior.description_th,
        model: `${prior.model}+inherit`,
        processed_at: new Date().toISOString(),
      });
      await ack(msg.msg_id);
      return;
    }
  }

  // Camera switched off (ADR-011): keep the event, skip paid analysis.
  if (row.cameras?.enabled === false) {
    await updateAi(eventId, {
      verified: null,
      severity: null,
      description_th: null,
      model: null,
      processed_at: new Date().toISOString(),
    });
    await ack(msg.msg_id);
    return;
  }

  try {
    const { analysis, detector, gateSkipped } = await analyzeEvent(row);
    if (analysis) {
      await updateAi(eventId, {
        verified: analysis.verified,
        severity: analysis.severity,
        description_th: analysis.description_th,
        model: analysis.model,
        processed_at: new Date().toISOString(),
        detector,
      });
      console.log(
        `worker: ${eventId} → ${analysis.verified ? "จริง" : "หลอก"} [${analysis.severity}] ${analysis.description_th}`,
      );
      if (analysis.uncertain && analysis.question_th) {
        await sendUncertainQuestion(row, analysis);
      } else {
        await maybeSendLineAlert(row, analysis);
      }
    } else if (gateSkipped) {
      // ADR-015 gate: detector saw no person/vehicle in a motion-type event —
      // record it as a false alarm without paying for the VLM. Visible on the
      // dashboard, no LINE. Never inherited (verified=false).
      await updateAi(eventId, {
        verified: false,
        severity: "info",
        description_th: "ไม่พบคน/รถในภาพ (กรองโดยตัวตรวจจับก่อนถึง AI)",
        model: DETECTOR_GATE_MODEL,
        processed_at: new Date().toISOString(),
        detector,
      });
      console.log(`worker: ${eventId} → ⏭️ กรองโดย detector (ไม่เรียก Gemini)`);
    } else {
      // No snapshot to analyze — still stamp processed_at so reconciliation
      // knows this event is settled and never re-enqueues it.
      await updateAi(eventId, {
        verified: null,
        severity: null,
        description_th: null,
        model: null,
        processed_at: new Date().toISOString(),
        detector,
      });
    }
    await ack(msg.msg_id);
  } catch (err) {
    const isTimeout = err instanceof VlmTimeoutError;
    console.error(
      `worker: ${eventId} attempt ${msg.read_ct} failed${isTimeout ? " (timeout)" : ""}:`,
      (err as Error).message,
    );
    if (msg.read_ct >= MAX_ATTEMPTS) {
      // Fail open: give up on analysis, mark as processed-without-result so the
      // raw event stands on its own. Never loop forever.
      await updateAi(eventId, {
        verified: null,
        severity: null,
        description_th: null,
        model: null,
        processed_at: new Date().toISOString(),
      });
      await ack(msg.msg_id);
      console.error(`worker: ${eventId} gave up after ${MAX_ATTEMPTS} attempts (fail-open)`);
    }
    // otherwise: leave message invisible until vt expires, pgmq redelivers
  }
}

// Site gone quiet past the threshold → one camera_offline event per outage.
// Idempotency via source_raw_id keyed on the frozen heartbeat_at, so restarts
// and repeated checks cannot double-alert for the same outage (ADR: 23505 = seen).
async function checkHeartbeats(): Promise<void> {
  const cutoff = new Date(
    Date.now() - HEARTBEAT_TIMEOUT_MIN * 60_000,
  ).toISOString();
  const { data, error } = await supabase
    .from("sites")
    .select("id, name, heartbeat_at")
    .eq("status", "active")
    .not("heartbeat_at", "is", null)
    .lt("heartbeat_at", cutoff);
  if (error) {
    console.error("worker: heartbeat query failed", error.message);
    return;
  }
  const now = new Date().toISOString();
  for (const site of data ?? []) {
    const { error: insertError } = await supabase.from("events").insert({
      event_id: uuidv7(),
      site_id: site.id,
      camera_id: null,
      source_type: "manual",
      source_raw_id: `heartbeat:${site.id}:${site.heartbeat_at}`,
      event_type: "camera_offline",
      occurred_at: now,
      received_at: now,
      detection: { label: null, confidence: null, zone: null, plate: null, bbox: null },
      media: { snapshot_path: null, clip_path: null, clip_status: "none" },
      ai: { verified: null, severity: null, description_th: null, model: null, processed_at: null },
      raw: {
        reason: "heartbeat_timeout",
        threshold_min: HEARTBEAT_TIMEOUT_MIN,
        last_heartbeat_at: site.heartbeat_at,
      },
    });
    if (insertError) {
      if (insertError.code !== "23505") {
        console.error("worker: offline event insert failed", insertError.message);
      }
    } else {
      console.log(
        `worker: ไซต์ "${site.name}" เงียบเกิน ${HEARTBEAT_TIMEOUT_MIN} นาที → camera_offline`,
      );
    }
  }

  // Per-camera pulse: one dead channel among many active ones must still alert.
  const { data: cams, error: camError } = await supabase
    .from("cameras")
    .select("id, name, site_id, last_event_at")
    .eq("enabled", true)
    .not("last_event_at", "is", null)
    .lt("last_event_at", cutoff);
  if (camError) {
    console.error("worker: camera heartbeat query failed", camError.message);
    return;
  }
  for (const cam of cams ?? []) {
    const { error: insertError } = await supabase.from("events").insert({
      event_id: uuidv7(),
      site_id: cam.site_id,
      camera_id: cam.id,
      source_type: "manual",
      source_raw_id: `cam-heartbeat:${cam.id}:${cam.last_event_at}`,
      event_type: "camera_offline",
      occurred_at: now,
      received_at: now,
      detection: { label: null, confidence: null, zone: null, plate: null, bbox: null },
      media: { snapshot_path: null, clip_path: null, clip_status: "none" },
      ai: { verified: null, severity: null, description_th: null, model: null, processed_at: null },
      raw: {
        reason: "camera_heartbeat_timeout",
        threshold_min: HEARTBEAT_TIMEOUT_MIN,
        last_event_at: cam.last_event_at,
      },
    });
    if (insertError) {
      if (insertError.code !== "23505") {
        console.error("worker: camera offline insert failed", insertError.message);
      }
    } else {
      console.log(`worker: กล้อง "${cam.name}" เงียบเกิน ${HEARTBEAT_TIMEOUT_MIN} นาที → camera_offline`);
    }
  }
}

// ADR-012: retention — delete old events + snapshots; keep feedback-labelled
// events (training data, ADR-008) but drop their images.
const RETENTION_SWEEP_MS = 6 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 60;

async function sweepRetention(): Promise<void> {
  const { data: sites, error } = await supabase
    .from("sites")
    .select("id, name, rules");
  if (error) {
    console.error("worker: retention site query failed", error.message);
    return;
  }
  for (const site of sites ?? []) {
    const days =
      (site.rules as { retention_days?: number } | null)?.retention_days ??
      DEFAULT_RETENTION_DAYS;
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const { data: rows, error: evError } = await supabase
      .from("events")
      .select("event_id, media, alerts(feedback)")
      .eq("site_id", site.id)
      .lt("occurred_at", cutoff)
      .limit(500);
    if (evError || !rows || rows.length === 0) continue;

    const paths = rows
      .map((r) => (r.media as { snapshot_path?: string } | null)?.snapshot_path)
      .filter((p): p is string => !!p);
    for (let i = 0; i < paths.length; i += 100) {
      const { error: rmError } = await supabase.storage
        .from("snapshots")
        .remove(paths.slice(i, i + 100));
      if (rmError) console.error("worker: snapshot delete failed", rmError.message);
    }

    const withFeedback = rows.filter((r) =>
      (r.alerts as { feedback: string | null }[] | null)?.some((a) => a.feedback),
    );
    const deletable = rows.filter((r) => !withFeedback.includes(r));

    if (deletable.length > 0) {
      const { error: delError } = await supabase
        .from("events")
        .delete()
        .in("event_id", deletable.map((r) => r.event_id));
      if (delError) console.error("worker: event delete failed", delError.message);
    }
    for (const r of withFeedback) {
      await supabase
        .from("events")
        .update({ media: { snapshot_path: null, clip_path: null, clip_status: "none" } })
        .eq("event_id", r.event_id);
    }
    console.log(
      `worker: retention "${site.name}" — ลบ ${deletable.length} events, เก็บ ${withFeedback.length} ที่มี feedback (ลบเฉพาะรูป), เกิน ${days} วัน`,
    );
  }
}

// M2: the bell. Verified abnormal events, filtered by the site's own rules,
// reach LINE within seconds — everything else stays on the dashboard (ADR-006).
async function maybeSendLineAlert(
  row: EventRow,
  analysis: VlmAnalysis,
): Promise<void> {
  try {
    const to = row.sites?.line_group_id;
    if (!to || !process.env.LINE_CHANNEL_ACCESS_TOKEN) return;

    // Alert-first follow-up: if the webhook already rang the raw bell, send the
    // AI verdict as a short text — including the all-clear on false alarms.
    const { data: prior } = await supabase
      .from("alerts")
      .select("id")
      .eq("event_id", row.event_id)
      .not("sent_at", "is", null)
      .limit(1);
    if ((prior?.length ?? 0) > 0) {
      const text = analysis.verified
        ? `🤖 ผลวิเคราะห์ (${row.cameras?.name ?? ""}): ${analysis.description_th}`
        : `✅ AI ตรวจสอบแล้ว น่าจะเป็นการแจ้งเตือนหลอก: ${analysis.description_th}`;
      const followup = await pushLineMessage(to, [{ type: "text", text }]);
      if (!followup.ok) console.error(`worker: follow-up failed: ${followup.error}`);
      return;
    }

    if (!analysis.verified) return;
    const rules = row.sites?.rules ?? {};
    if (rules.alerts?.[row.event_type] === false) return;
    if (!severityPasses(rules.sensitivity, analysis.severity)) return;

    let imageUrl: string | null = null;
    if (row.media?.snapshot_path) {
      const { data: signed } = await supabase.storage
        .from("snapshots")
        .createSignedUrl(row.media.snapshot_path, 86_400);
      imageUrl = signed?.signedUrl ?? null;
    }

    const timeTh = new Date(row.occurred_at).toLocaleTimeString("th-TH", {
      timeZone: "Asia/Bangkok",
      hour: "2-digit",
      minute: "2-digit",
    });
    const flex = buildAlertFlex({
      severity: analysis.severity,
      eventTypeTh: TYPE_TH[row.event_type as EventType] ?? row.event_type,
      descriptionTh: analysis.description_th || "ตรวจพบเหตุการณ์",
      cameraName: row.cameras?.name ?? "ไม่ระบุกล้อง",
      siteName: row.sites?.name ?? "",
      timeTh: `${timeTh} น.`,
      imageUrl,
      dashboardUrl: `${APP_URL}/dashboard/sites/${row.site_id}`,
    });

    const result = await pushLineMessage(to, [flex]);
    if (result.ok) {
      await supabase.from("alerts").insert({
        event_id: row.event_id,
        channel: "line",
        sent_at: new Date().toISOString(),
      });
      console.log(`worker: 🔔 LINE alert sent for ${row.event_id}`);
    } else {
      console.error(`worker: LINE send failed for ${row.event_id}: ${result.error}`);
    }
  } catch (err) {
    // Alerting must never break the analysis pipeline.
    console.error("worker: LINE alert error", (err as Error).message);
  }
}

// M2/M5: daily report at 06:00 Bangkok — idempotent via the reports table.
function bangkokDateString(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" });
}

async function maybeSendDailyReports(): Promise<void> {
  const nowHHmm = bangkokNowHHmm();
  if (nowHHmm < "06:00" || nowHHmm > "06:15") return; // 15-min window, guarded by reports row

  const reportDate = bangkokDateString(1); // yesterday, Bangkok
  const { data: sites } = await supabase
    .from("sites")
    .select("id, name, line_group_id")
    .not("line_group_id", "is", null);

  for (const site of sites ?? []) {
    const { data: existing } = await supabase
      .from("reports")
      .select("id")
      .eq("site_id", site.id)
      .eq("report_date", reportDate)
      .eq("period", "daily")
      .maybeSingle();
    if (existing) continue;

    const dayStart = new Date(`${reportDate}T00:00:00+07:00`).toISOString();
    const dayEnd = new Date(`${bangkokDateString(0)}T00:00:00+07:00`).toISOString();
    const { data: events } = await supabase
      .from("events")
      .select("event_type, occurred_at, ai, cameras(name)")
      .eq("site_id", site.id)
      .gte("occurred_at", dayStart)
      .lt("occurred_at", dayEnd)
      .limit(2000);

    const rows = (events ?? []) as unknown as {
      event_type: string;
      occurred_at: string;
      ai: { verified: boolean | null; severity: string | null; description_th: string | null } | null;
      cameras: { name: string } | null;
    }[];
    const abnormal = rows.filter(
      (r) =>
        r.ai?.verified === true &&
        (r.ai.severity === "warning" || r.ai.severity === "critical"),
    );
    const vehicles = rows.filter(
      (r) => r.event_type === "vehicle_detected" || r.event_type === "lpr",
    ).length;
    const offline = rows.filter((r) => r.event_type === "camera_offline").length;

    const stats = {
      total: rows.length,
      abnormal: abnormal.length,
      vehicles,
      offline_incidents: offline,
    };
    const text = buildDailyReportText({
      siteName: site.name,
      dateTh: new Date(`${reportDate}T12:00:00+07:00`).toLocaleDateString("th-TH", {
        timeZone: "Asia/Bangkok",
        weekday: "long",
        day: "numeric",
        month: "short",
      }),
      total: rows.length,
      abnormalLines: abnormal.slice(0, 5).map((r) => {
        const t = new Date(r.occurred_at).toLocaleTimeString("th-TH", {
          timeZone: "Asia/Bangkok",
          hour: "2-digit",
          minute: "2-digit",
        });
        return `${t} ${r.ai?.description_th ?? r.event_type} (${r.cameras?.name ?? ""})`;
      }),
      vehicles,
      camerasOnline: "ครบทุกตัว",
      offlineIncidents: offline,
      reportUrl: `${APP_URL}/dashboard/sites/${site.id}/report`,
    });

    const result = await pushLineMessage(site.line_group_id as string, [
      { type: "text", text },
    ]);
    await supabase.from("reports").insert({
      site_id: site.id,
      report_date: reportDate,
      period: "daily",
      stats,
      sent_at: result.ok ? new Date().toISOString() : null,
    });
    console.log(
      `worker: ☀️ daily report "${site.name}" ${reportDate} — ${result.ok ? "sent" : `failed: ${result.error}`}`,
    );
  }
}

// ADR-013: the model is unsure — ask the humans instead of guessing, and
// remember the answer forever via the LINE webhook teach-by-reply flow.
async function sendUncertainQuestion(
  row: EventRow,
  analysis: VlmAnalysis,
): Promise<void> {
  try {
    const to = row.sites?.line_group_id;
    if (!to || !process.env.LINE_CHANNEL_ACCESS_TOKEN || !analysis.question_th) return;

    let imageUrl: string | null = null;
    if (row.media?.snapshot_path) {
      const { data: signed } = await supabase.storage
        .from("snapshots")
        .createSignedUrl(row.media.snapshot_path, 86_400);
      imageUrl = signed?.signedUrl ?? null;
    }
    const flex = buildAlertFlex({
      severity: "warning",
      eventTypeTh: "ระบบขอคำแนะนำ 🙋",
      descriptionTh: `${analysis.question_th}\n\n💬 พิมพ์ตอบข้อความนี้ได้เลย — ระบบจะจำคำตอบไว้ใช้ตลอดไป`,
      cameraName: row.cameras?.name ?? "ไม่ระบุกล้อง",
      siteName: row.sites?.name ?? "",
      timeTh: `${new Date(row.occurred_at).toLocaleTimeString("th-TH", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit" })} น.`,
      imageUrl,
      dashboardUrl: `${APP_URL}/dashboard/sites/${row.site_id}`,
    });
    const sent = await pushLineMessage(to, [flex]);
    if (sent.ok) {
      await supabase.from("pending_questions").insert({
        site_id: row.site_id,
        event_id: row.event_id,
        line_target: to,
        question_th: analysis.question_th,
      });
      console.log(`worker: 🙋 asked human about ${row.event_id}: ${analysis.question_th}`);
    } else {
      console.error(`worker: question send failed: ${sent.error}`);
    }
  } catch (err) {
    console.error("worker: question error", (err as Error).message);
  }
}

// ADR-014: once a day, each active camera distills its recent "normal"
// verdicts into a baseline paragraph — the system learning the site on its own.
let lastBaselineDate = "";
async function maybeLearnBaselines(): Promise<void> {
  const nowHHmm = bangkokNowHHmm();
  const today = bangkokDateString(0);
  if (nowHHmm < "05:00" || nowHHmm > "05:20" || lastBaselineDate === today) return;
  lastBaselineDate = today;
  await learnBaselines();
}

async function learnBaselines(): Promise<void> {
  const { data: cams } = await supabase
    .from("cameras")
    .select("id, name, camera_profiles(name_th)")
    .eq("enabled", true);
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  for (const cam of cams ?? []) {
    const { data: locked } = await supabase
      .from("camera_baselines")
      .select("locked")
      .eq("camera_id", cam.id)
      .maybeSingle();
    if (locked?.locked) continue; // human-edited — hands off

    const { data: rows } = await supabase
      .from("events")
      .select("ai")
      .eq("camera_id", cam.id)
      .gte("occurred_at", since)
      .filter("ai->>verified", "eq", "true")
      .filter("ai->>severity", "eq", "info")
      .order("occurred_at", { ascending: false })
      .limit(150);
    const descriptions = (rows ?? [])
      .map((r) => (r.ai as AiResult | null)?.description_th)
      .filter((d): d is string => !!d)
      .map((d) => d.replace(/(\s*\(สืบเนื่องจากเหตุก่อนหน้า\))+$/g, ""));
    // Dedupe inherited copies so the summary is not skewed by repeats.
    const unique = [...new Set(descriptions)];
    if (unique.length < 10) continue; // not enough to generalise from

    try {
      await vlmThrottle();
      const profileName =
        (cam as unknown as { camera_profiles: { name_th: string } | null }).camera_profiles?.name_th ?? null;
      const baseline = await summarizeBaseline(cam.name, profileName, unique.slice(0, 100));
      await supabase.from("camera_baselines").upsert({
        camera_id: cam.id,
        baseline_th: baseline,
        sample_count: unique.length,
        locked: false,
        updated_at: new Date().toISOString(),
      });
      console.log(`worker: 🧠 baseline "${cam.name}" (${unique.length} ตัวอย่าง): ${baseline.slice(0, 80)}...`);
    } catch (err) {
      console.error(`worker: baseline "${cam.name}" failed:`, (err as Error).message);
    }
  }
}

// ADR-012: dead-man switch — the dashboard warns admins if this pulse stops.
async function pulseSystemStatus(): Promise<void> {
  const { error } = await supabase.from("system_status").upsert({
    key: "worker_heartbeat",
    // Detector state travels with the heartbeat so it can be diagnosed from
    // anywhere (Railway logs are not reachable from a dev laptop).
    value: {
      pid: process.pid,
      detector: {
        mode: DETECTOR_MODE,
        ready: detectorReady(),
        reason: detectorDisabledReason(),
        model: MODEL_PATH,
      },
    },
    updated_at: new Date().toISOString(),
  });
  if (error) console.error("worker: status pulse failed", error.message);
}

// Reconciliation (architecture doc §ความทนทาน): events whose enqueue was lost
// (webhook enqueue failure, crash between insert and send) sit with a null
// processed_at forever. Sweep them back into the queue. Duplicate messages are
// harmless — handleMessage acks already-processed events untouched.
const RECONCILE_MS = 120_000;
const RECONCILE_MIN_AGE_MS = 3 * 60_000;

async function reconcileStuckEvents(): Promise<void> {
  const cutoff = new Date(Date.now() - RECONCILE_MIN_AGE_MS).toISOString();
  const { data, error } = await supabase
    .from("events")
    .select("event_id")
    .filter("ai->>processed_at", "is", null)
    .lt("received_at", cutoff)
    .limit(20);
  if (error) {
    console.error("worker: reconcile query failed", error.message);
    return;
  }
  for (const row of data ?? []) {
    const { error: enqueueError } = await supabase.rpc("enqueue_event", {
      p_event_id: row.event_id,
    });
    if (enqueueError) {
      console.error(`worker: reconcile enqueue ${row.event_id} failed`, enqueueError.message);
    } else {
      console.log(`worker: reconcile — requeued stuck event ${row.event_id}`);
    }
  }
}

let draining = false;
async function drainQueue(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    for (;;) {
      // vt 30s: a failed VLM attempt retries in half a minute, not 1.5 — an
      // intrusion alert cannot afford leisurely retries.
      const { data, error } = await supabase.rpc("dequeue_events", {
        p_limit: 5,
        p_vt: 30,
      });
      if (error) {
        console.error("worker: dequeue failed", error.message);
        break;
      }
      const messages = (data ?? []) as QueueMessage[];
      if (messages.length === 0) break;
      for (const msg of messages) {
        await handleMessage(msg);
      }
    }
  } catch (err) {
    console.error("worker: drain error", (err as Error).message);
  } finally {
    draining = false;
  }
}

async function main(): Promise<void> {
  console.log("tassana-ai worker: started (pgmq → Gemini → events.ai)");
  // ADR-015: warm the detector at boot so the first event does not pay for
  // the model download + session creation. Failure here is not fatal.
  if (DETECTOR_MODE !== "off") {
    console.log(`worker: detector mode=${DETECTOR_MODE}, loading model in background…`);
    warmDetector();
    // Retry loop is cheap and self-throttling; the pipeline never waits on it.
    setInterval(() => {
      if (!detectorReady()) warmDetector();
    }, 60_000);
  } else {
    console.log("worker: detector off (YOLO_MODE=off)");
  }
  void checkHeartbeats();
  setInterval(() => void checkHeartbeats(), HEARTBEAT_CHECK_MS);
  void reconcileStuckEvents();
  setInterval(() => void reconcileStuckEvents(), RECONCILE_MS);
  void sweepRetention();
  setInterval(() => void sweepRetention(), RETENTION_SWEEP_MS);
  void pulseSystemStatus();
  setInterval(() => void pulseSystemStatus(), 60_000);
  void maybeSendDailyReports();
  setInterval(() => void maybeSendDailyReports(), 60_000);
  setInterval(() => void maybeLearnBaselines(), 60_000);
  if (process.env.LEARN_BASELINES_ON_START === "1") {
    await learnBaselines();
    if (process.env.LEARN_ONLY === "1") {
      console.log("worker: learn-only run finished");
      process.exit(0);
    }
  }

  // Push wake (requires the events table in the realtime publication): a new
  // event nudges the worker instantly instead of waiting out the poll cycle.
  supabase
    .channel("events-wake")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "events" },
      () => void drainQueue(),
    )
    .subscribe((status) => console.log(`worker: realtime wake ${status}`));

  // Polling stays as the safety net.
  for (;;) {
    await drainQueue();
    await sleep(POLL_INTERVAL_MS);
  }
}

void main();
