import { createClient } from "@supabase/supabase-js";
import {
  analyzeSnapshot,
  VlmTimeoutError,
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
const MAX_ATTEMPTS = 3;

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
  cameras: { name: string } | null;
  sites: { name: string } | null;
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
  return analyzeSnapshot(base64, mime, {
    eventType: row.event_type,
    cameraName: row.cameras?.name ?? "ไม่ระบุกล้อง",
    siteName: row.sites?.name ?? "ไม่ระบุไซต์",
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
    .select("event_id, event_type, media, ai, cameras(name), sites(name)")
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

async function main(): Promise<void> {
  console.log("tassana-ai worker: started (pgmq → Gemini → events.ai)");
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
