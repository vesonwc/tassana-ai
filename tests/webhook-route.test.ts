import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Supabase mock -----------------------------------------------------------
const state = {
  site: { id: "site-uuid-1", status: "active" } as { id: string } | null,
  camera: { id: "cam-uuid-1" } as { id: string } | null,
  insertDuplicate: false,
  insertCalls: [] as unknown[],
  cameraInserts: [] as unknown[],
  rpcCalls: [] as { fn: string; args: unknown }[],
  heartbeatCalls: 0,
};

function fakeClient() {
  return {
    from(table: string) {
      if (table === "sites") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: state.site, error: null }),
            }),
          }),
          update: () => ({
            eq: () => ({
              then: (resolve: (r: { error: null }) => void) => {
                state.heartbeatCalls += 1;
                resolve({ error: null });
              },
            }),
          }),
        };
      }
      if (table === "cameras") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: state.camera, error: null }),
                }),
              }),
            }),
          }),
          insert: (row: unknown) => {
            state.cameraInserts.push(row);
            return {
              select: () => ({
                maybeSingle: async () => ({ data: { id: "cam-new" }, error: null }),
              }),
            };
          },
          update: () => ({
            eq: () => ({
              then: (resolve: (r: { error: null }) => void) => {
                resolve({ error: null });
              },
            }),
          }),
        };
      }
      if (table === "events") {
        return {
          insert: async (row: unknown) => {
            state.insertCalls.push(row);
            return {
              error: state.insertDuplicate
                ? { code: "23505", message: "duplicate key value" }
                : null,
            };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
    rpc: async (fn: string, args: unknown) => {
      state.rpcCalls.push({ fn, args });
      return { data: 1, error: null };
    },
  };
}

vi.mock("@/lib/supabase", () => ({
  getServiceClient: () => fakeClient(),
}));

import { POST } from "@/app/api/webhook/[siteKey]/route";
import type { NormalizedEvent } from "@/lib/types";

// --- helpers -----------------------------------------------------------------
const GOOD_PAYLOAD = {
  test_source: "hikvision_isapi",
  eventType: "linedetection",
  channelID: "1",
  dateTime: "2026-08-09T02:14:00+07:00",
  activePostCount: "1",
  eventDescription: "linedetection alarm",
};

function makeRequest(body: string) {
  return new Request("http://localhost/api/webhook/whatever", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

function callRoute(siteKey: string, body: string) {
  return POST(makeRequest(body), { params: Promise.resolve({ siteKey }) });
}

beforeEach(() => {
  state.site = { id: "site-uuid-1" };
  state.camera = { id: "cam-uuid-1" };
  state.insertDuplicate = false;
  state.insertCalls = [];
  state.cameraInserts = [];
  state.rpcCalls = [];
  state.heartbeatCalls = 0;
});

// --- tests -------------------------------------------------------------------
describe("POST /api/webhook/[siteKey]", () => {
  it("returns 401 for an unknown siteKey", async () => {
    state.site = null;
    const res = await callRoute("wrong-key", JSON.stringify(GOOD_PAYLOAD));
    expect(res.status).toBe(401);
    expect(state.insertCalls).toHaveLength(0);
    expect(state.rpcCalls).toHaveLength(0);
  });

  it("returns 400 for a non-JSON body", async () => {
    const res = await callRoute("good-key", "this is not json");
    expect(res.status).toBe(400);
    expect(state.insertCalls).toHaveLength(0);
  });

  it("normalizes, inserts, and enqueues a valid event (201)", async () => {
    const res = await callRoute("good-key", JSON.stringify(GOOD_PAYLOAD));
    expect(res.status).toBe(201);

    const body = (await res.json()) as {
      ok: boolean;
      duplicate: boolean;
      event_id: string;
    };
    expect(body.ok).toBe(true);
    expect(body.duplicate).toBe(false);

    expect(state.insertCalls).toHaveLength(1);
    const row = state.insertCalls[0] as NormalizedEvent;
    expect(row.site_id).toBe("site-uuid-1");
    expect(row.camera_id).toBe("cam-uuid-1");
    expect(row.event_type).toBe("line_crossing");
    expect(row.source_type).toBe("hikvision_isapi");
    expect(row.source_raw_id).toBe(
      "linedetection:1:2026-08-09T02:14:00+07:00",
    );
    // Device time is far from "now" in this fixture → clock-skew guard fires,
    // annotating raw; the original payload fields must still be intact.
    expect(row.raw).toMatchObject(GOOD_PAYLOAD);
    expect(typeof row.raw._device_clock_skew_sec).toBe("number");
    expect(body.event_id).toBe(row.event_id);

    expect(state.rpcCalls).toEqual([
      { fn: "enqueue_event", args: { p_event_id: row.event_id } },
    ]);
  });

  it("returns 200 duplicate:true and does not enqueue when the event already exists", async () => {
    state.insertDuplicate = true;
    const res = await callRoute("good-key", JSON.stringify(GOOD_PAYLOAD));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { duplicate: boolean; event_id: null };
    expect(body.duplicate).toBe(true);
    expect(body.event_id).toBeNull();
    expect(state.rpcCalls).toHaveLength(0);
  });

  it("auto-registers an unknown camera as disabled and skips analysis (ADR-011)", async () => {
    state.camera = null;
    const res = await callRoute("good-key", JSON.stringify(GOOD_PAYLOAD));
    expect(res.status).toBe(201);
    const row = state.insertCalls[0] as NormalizedEvent;
    expect(row.camera_id).toBe("cam-new");
    expect(state.cameraInserts).toHaveLength(1);
    expect(state.cameraInserts[0]).toMatchObject({
      source_camera_ref: "1",
      enabled: false,
    });
    // Disabled camera → event stored but never enqueued for paid analysis.
    expect(state.rpcCalls).toHaveLength(0);
  });

  it("stores an unrecognizable payload as manual/unknown instead of dropping it", async () => {
    const res = await callRoute("good-key", JSON.stringify({ hello: "world" }));
    expect(res.status).toBe(201);
    const row = state.insertCalls[0] as NormalizedEvent;
    expect(row.source_type).toBe("manual");
    expect(row.event_type).toBe("unknown");
    expect(row.raw).toEqual({ hello: "world" });
  });
});

