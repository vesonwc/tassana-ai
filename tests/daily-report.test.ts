import { describe, expect, it } from "vitest";
import { buildDailyReportText } from "@/lib/line";

const base = {
  siteName: "สำนักงานใหญ่",
  dateTh: "จันทร์ 18 ส.ค.",
  total: 268,
  abnormalLines: [] as string[],
  vehicles: 12,
  camerasOnline: "3/3",
  offlineIncidents: 0,
  reportUrl: "https://example.test/report",
};

describe("buildDailyReportText — night activity line", () => {
  it("reports routine night movement instead of staying silent about it", () => {
    const text = buildDailyReportText({
      ...base,
      nightActivity: { count: 5, firstTh: "00:01", lastTh: "07:08" },
    });
    expect(text).toContain("กลางคืนมีคนเคลื่อนไหว 5 ครั้ง");
    expect(text).toContain("00:01–07:08");
  });

  it("omits the line entirely on a quiet night", () => {
    expect(buildDailyReportText({ ...base, nightActivity: null })).not.toContain("กลางคืน");
    expect(buildDailyReportText(base)).not.toContain("กลางคืน");
    expect(buildDailyReportText({ ...base, nightActivity: { count: 0, firstTh: "", lastTh: "" } })).not.toContain("กลางคืน");
  });

  it("still leads with abnormal events when there are any", () => {
    const text = buildDailyReportText({
      ...base,
      abnormalLines: ["03:14 พบคนปีนรั้ว (กล้องรั้วหลัง)"],
      nightActivity: { count: 2, firstTh: "01:00", lastTh: "05:00" },
    });
    expect(text).toContain("เหตุควรทราบ 1 รายการ");
    expect(text.indexOf("🔴")).toBeLessThan(text.indexOf("🌙"));
  });
});
