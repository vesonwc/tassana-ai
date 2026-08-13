import { describe, expect, it } from "vitest";
import { buildPrompt, isWithinStrictHours } from "@/lib/vlm";

const BASE_CTX = {
  eventType: "person_detected",
  cameraName: "กล้องประตูหน้า",
  siteName: "หมู่บ้านทดสอบ",
};

describe("buildPrompt — three config layers (ADR-011)", () => {
  it("layer 1 base watch list is always present and cannot be omitted", () => {
    const prompt = buildPrompt(BASE_CTX);
    expect(prompt).toContain("คนล้มแล้วไม่ลุก");
    expect(prompt).toContain("ควันหรือเปลวไฟ");
    expect(prompt).toContain("กล้องถูกบัง");
  });

  it("layer 2 profile prompt is appended when the camera has a role", () => {
    const prompt = buildPrompt({
      ...BASE_CTX,
      profileName: "รั้ว/แนวเขต",
      profilePrompt: "พื้นที่นี้ปกติต้องไม่มีคน",
    });
    expect(prompt).toContain("หน้าที่เฉพาะของกล้องนี้ (รั้ว/แนวเขต)");
    expect(prompt).toContain("พื้นที่นี้ปกติต้องไม่มีคน");
    expect(buildPrompt(BASE_CTX)).not.toContain("หน้าที่เฉพาะของกล้องนี้");
  });

  it("layer 3 free-text instructions from site and camera are both included", () => {
    const prompt = buildPrompt({
      ...BASE_CTX,
      siteInstructions: "ช่วงปิดปรับปรุงสระ ถ้ามีคนเข้าเขตสระให้แจ้งทันที",
      cameraInstructions: "ดูรถจอดขวางประตูหนีไฟ",
    });
    expect(prompt).toContain("คำสั่งเพิ่มเติมจากผู้ดูแล");
    expect(prompt).toContain("ช่วงปิดปรับปรุงสระ");
    expect(prompt).toContain("ดูรถจอดขวางประตูหนีไฟ");
  });

  it("layer 4 taught knowledge is injected and the ask-when-unsure schema is present", () => {
    const prompt = buildPrompt({
      ...BASE_CTX,
      knowledge: ["บ้านนี้มีแมวส้ม 1 ตัว เดินแถวรั้วเป็นประจำ"],
    });
    expect(prompt).toContain("ความรู้เฉพาะไซต์นี้ที่ผู้ดูแลเคยสอนไว้");
    expect(prompt).toContain("แมวส้ม");
    expect(prompt).toContain('"uncertain"');
    expect(prompt).toContain("question_th");
    expect(buildPrompt(BASE_CTX)).not.toContain("ความรู้เฉพาะไซต์นี้");
  });

  it("strict-hours context escalates wording only inside the window", () => {
    const strict = { start: "22:00", end: "06:00" };
    const night = buildPrompt({ ...BASE_CTX, strictHours: strict, nowBangkok: "02:14" });
    const day = buildPrompt({ ...BASE_CTX, strictHours: strict, nowBangkok: "14:00" });
    expect(night).toContain("ช่วงเฝ้าระวังเข้มข้น");
    expect(day).toContain("ช่วงเวลาปกติ");
  });
});

describe("isWithinStrictHours", () => {
  it("handles overnight windows that wrap midnight", () => {
    expect(isWithinStrictHours("23:00", "22:00", "06:00")).toBe(true);
    expect(isWithinStrictHours("02:00", "22:00", "06:00")).toBe(true);
    expect(isWithinStrictHours("12:00", "22:00", "06:00")).toBe(false);
  });
  it("handles same-day windows", () => {
    expect(isWithinStrictHours("13:00", "12:00", "14:00")).toBe(true);
    expect(isWithinStrictHours("15:00", "12:00", "14:00")).toBe(false);
  });
});
