# Event Schema กลาง (หัวใจของระบบ — แก้ไฟล์นี้ = ต้องมี ADR)

ทุก adapter (Hikvision, Dahua, Frigate, manual) ต้องแปลง payload ต้นทางเป็น `NormalizedEvent`
ก่อน insert เสมอ ห้ามเขียนตารางตรงจาก payload ดิบ

## NormalizedEvent (TypeScript)

```typescript
type EventType =
  | "person_detected"
  | "vehicle_detected"
  | "line_crossing"       // ข้ามเส้น (รั้ว/ประตู)
  | "intrusion"           // เข้าโซนหวงห้าม
  | "loitering"           // เดินเตร่
  | "lpr"                 // อ่านป้ายทะเบียน
  | "camera_offline"
  | "camera_online"
  | "unknown";            // แปลงไม่ได้ → เก็บไว้ดูใน raw เสมอ

type SourceType = "hikvision_isapi" | "dahua" | "onvif" | "frigate" | "manual";

interface NormalizedEvent {
  event_id: string;            // uuid v7 (เรียงตามเวลาได้)
  site_id: string;             // FK -> sites
  camera_id: string | null;    // FK -> cameras (null ถ้าระบุกล้องไม่ได้)
  source_type: SourceType;
  source_raw_id: string | null; // id ฝั่งอุปกรณ์ ใช้กัน event ซ้ำ (idempotency key ร่วมกับ site_id)
  event_type: EventType;
  occurred_at: string;         // ISO8601 +07:00 เวลาที่เกิดเหตุฝั่งอุปกรณ์
  received_at: string;         // เวลาที่ระบบเรารับ (ผลต่างสองค่านี้ = latency ที่ต้อง monitor)
  detection: {
    label: string | null;      // "person" | "car" | "motorcycle" | ...
    confidence: number | null; // 0-1
    zone: string | null;       // ชื่อโซนที่ตั้งไว้ เช่น "รั้วหลัง"
    plate: string | null;      // ทะเบียนรถ (เฉพาะ lpr)
    bbox: [number, number, number, number] | null; // x,y,w,h แบบ normalized 0-1
  };
  media: {
    snapshot_path: string | null;  // path ใน Supabase Storage
    clip_path: string | null;
    clip_status: "none" | "pending" | "ready" | "failed";
  };
  ai: {
    verified: boolean | null;      // null = ยังไม่วิเคราะห์, true = เหตุจริง, false = หลอก
    severity: "info" | "warning" | "critical" | null;
    description_th: string | null; // คำบรรยายภาษาไทยจาก VLM
    model: string | null;
    processed_at: string | null;
  };
  raw: Record<string, unknown>;    // payload ดิบทั้งก้อน เก็บเสมอ (debug + จูนภายหลัง)
}
```

## ตารางฐานข้อมูล (Supabase)

```
sites      id, name, site_key (ลับ, ใช้ใน webhook URL), mode (no_box|edge_box),
           line_group_id, timezone, status, heartbeat_at, created_at
cameras    id, site_id, name, location_note, source_type, source_camera_ref,
           status, last_event_at, created_at
events     (ตาม NormalizedEvent ข้างบน; detection/media/ai/raw เป็น jsonb)
           index: (site_id, occurred_at desc), unique (site_id, source_type, source_raw_id)
alerts     id, event_id, channel (line), sent_at, message_id,
           feedback (null|confirmed|false_alarm), feedback_by, feedback_at
reports    id, site_id, report_date, period (daily|monthly), pdf_path,
           stats jsonb, sent_at
```

กติกา: `alerts.feedback = false_alarm` คือข้อมูลที่มีค่าที่สุดในระบบ — เก็บให้ครบตั้งแต่วันแรก
ใช้จูน prompt ของ VLM และเป็นสมบัติที่คู่แข่งลอกไม่ได้

## ตัวอย่างการแปลง

### Hikvision ISAPI → NormalizedEvent
Hikvision ยิง XML `EventNotificationAlert` เช่น eventType `linedetection`, `fielddetection` (intrusion), `VMD` (motion)

| Hikvision eventType | event_type ของเรา |
|---|---|
| linedetection | line_crossing |
| fielddetection | intrusion |
| loitering | loitering |
| vehicledetection / ANPR | lpr |
| videoloss | camera_offline |
| อื่น ๆ ที่ไม่รู้จัก | unknown (เก็บ raw ไว้) |

### Frigate MQTT → NormalizedEvent
Frigate publish JSON ที่ topic `frigate/events` (type: new/update/end)
- ใช้เฉพาะ `type: "new"` สร้าง event (update/end ใช้อัปเดต clip_status)
- `after.label` → detection.label, `after.top_score` → confidence,
  `after.entered_zones[0]` → zone, `after.id` → source_raw_id
- label "person" → person_detected, "car"/"motorcycle" → vehicle_detected

### ตัวอย่าง payload ปลอมสำหรับทดสอบ (ใช้กับ curl ใน Milestone 1)

```json
{
  "test_source": "hikvision_isapi",
  "eventType": "linedetection",
  "channelID": "1",
  "dateTime": "2026-08-09T02:14:00+07:00",
  "activePostCount": "1",
  "eventDescription": "linedetection alarm"
}
```
