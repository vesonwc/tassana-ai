import type { EventType } from "@/lib/types";

// Shared Thai labels — the dashboard speaks only Thai (ADR-010 rule 5).
export const TYPE_TH: Record<EventType, string> = {
  person_detected: "พบบุคคล",
  vehicle_detected: "พบยานพาหนะ",
  line_crossing: "ข้ามเส้น",
  intrusion: "บุกรุกโซนหวงห้าม",
  loitering: "เดินเตร่",
  lpr: "อ่านป้ายทะเบียน",
  camera_offline: "กล้องออฟไลน์",
  camera_online: "กล้องกลับมาออนไลน์",
  unknown: "ตรวจพบความเคลื่อนไหว",
};

export const ALARM_TYPES: EventType[] = [
  "intrusion",
  "line_crossing",
  "loitering",
  "camera_offline",
];

export const SEVERITY_TH: Record<string, string> = {
  info: "ทั่วไป",
  warning: "ควรตรวจสอบ",
  critical: "ฉุกเฉิน",
};

export function formatThaiTime(iso: string): string {
  return new Date(iso).toLocaleString("th-TH", {
    timeZone: "Asia/Bangkok",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
