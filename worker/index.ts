import { createClient } from "@supabase/supabase-js";
import { v7 as uuidv7 } from "uuid";
import {
  analyzeSnapshot,
  VlmRateLimitError,
  VlmTimeoutError,
  type SnapshotContext,
  type VlmAnalysis,
} from "../lib/vlm";
import type { AiResult } from "../lib/types";

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
  process.env.GEMINI_FALLBACK_MODEL ?? "gemini-flash-lite-latest";
const HEARTBEAT_CHECK_MS = 60_000;
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

interface EventRow {
  event_id: string;
  event_type: string;
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
    custom_instructions_th: string | null;
    rules: { strict_hours?: { start: string; end: string } } | null;
  } | null;
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
): Promise<VlmAnalysis> {
  await vlmThrottle();
  try {
    return await analyzeSnapshot(base64, mime, ctx);
  } catch (err) {
    if (!(err instanceof VlmRateLimitError)) throw err;
    console.warn(`worker: primary model rate-limited, trying ${VLM_FALLBACK_MODEL}`);
    await vlmThrottle();
    return analyzeSnapshot(base64, mime, ctx, VLM_FALLBACK_MODEL);
  }
}

async function analyzeEvent(row: EventRow): Promise<VlmAnalysis | null> {
  const snapshotPath = row.media?.snapshot_path;
  if (!snapshotPath) {
    console.log(`worker: ${row.event_id} has no snapshot, skipping analysis`);
    return null;
  }
  const { data: blob, error } = await supabase.storage
    .from("snapshots")
    .download(snapshotPath);
  if (error || !blob) {
    throw new Error(`snapshot download failed: ${error?.message}`);
  }
  const base64 = Buffer.from(await blob.arrayBuffer()).toString("base64");
  const mime = blob.type || "image/jpeg";
  // Assemble the three config layers (ADR-011) from data, not code.
  return analyzeWithFallback(base64, mime, {
    eventType: row.event_type,
    cameraName: row.cameras?.name ?? "ไม่ระบุกล้อง",
    siteName: row.sites?.name ?? "ไม่ระบุไซต์",
    profileName: row.cameras?.camera_profiles?.name_th ?? null,
    profilePrompt: row.cameras?.camera_profiles?.vlm_prompt_th ?? null,
    siteInstructions: row.sites?.custom_instructions_th ?? null,
    cameraInstructions: row.cameras?.custom_instructions_th ?? null,
    strictHours: row.sites?.rules?.strict_hours ?? null,
    nowBangkok: bangkokNowHHmm(),
  });
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
      "event_id, event_type, media, ai, cameras(name, enabled, custom_instructions_th, camera_profiles(name_th, vlm_prompt_th)), sites(name, custom_instructions_th, rules)",
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
    const analysis = await analyzeEvent(row);
    if (analysis) {
      await updateAi(eventId, {
        verified: analysis.verified,
        severity: analysis.severity,
        description_th: analysis.description_th,
        model: analysis.model,
        processed_at: new Date().toISOString(),
      });
      console.log(
        `worker: ${eventId} → ${analysis.verified ? "จริง" : "หลอก"} [${analysis.severity}] ${analysis.description_th}`,
      );
    } else {
      // No snapshot to analyze — still stamp processed_at so reconciliation
      // knows this event is settled and never re-enqueues it.
      await updateAi(eventId, {
        verified: null,
        severity: null,
        description_th: null,
        model: null,
        processed_at: new Date().toISOString(),
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

async function main(): Promise<void> {
  console.log("tassana-ai worker: started (pgmq → Gemini → events.ai)");
  void checkHeartbeats();
  setInterval(() => void checkHeartbeats(), HEARTBEAT_CHECK_MS);
  void reconcileStuckEvents();
  setInterval(() => void reconcileStuckEvents(), RECONCILE_MS);
  for (;;) {
    try {
      const { data, error } = await supabase.rpc("dequeue_events", {
        p_limit: 5,
        p_vt: 90,
      });
      if (error) {
        console.error("worker: dequeue failed", error.message);
        await sleep(POLL_INTERVAL_MS * 2);
        continue;
      }
      const messages = (data ?? []) as QueueMessage[];
      for (const msg of messages) {
        await handleMessage(msg);
      }
      await sleep(messages.length > 0 ? 500 : POLL_INTERVAL_MS);
    } catch (err) {
      console.error("worker: loop error", (err as Error).message);
      await sleep(POLL_INTERVAL_MS * 2);
    }
  }
}

void main();
