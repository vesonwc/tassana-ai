import { describe, expect, it } from "vitest";
import { sceneChanged } from "@/lib/scene-change";
import type { ObjectDetection } from "@/lib/detector-core";

const at = (label: string, x: number, y: number, w = 50, h = 100, confidence = 0.8): ObjectDetection => ({
  label,
  confidence,
  box: { x, y, w, h },
});

describe("sceneChanged — ADR-017 bridge filter", () => {
  it("always sends when there is no reference frame yet", () => {
    expect(sceneChanged(null, []).changed).toBe(true);
  });

  it("holds a parking lot whose cars have not moved", () => {
    const lot = [at("car", 0, 0), at("car", 200, 0), at("car", 400, 0)];
    const same = [at("car", 2, 1), at("car", 203, 2), at("car", 398, 0)];
    const r = sceneChanged(lot, same);
    expect(r.changed).toBe(false);
  });

  it("sends when a car arrives or leaves", () => {
    const lot = [at("car", 0, 0), at("car", 200, 0)];
    expect(sceneChanged(lot, [...lot, at("car", 400, 0)]).changed).toBe(true);
    expect(sceneChanged(lot, [at("car", 0, 0)]).changed).toBe(true);
  });

  it("sends when a person appears in an empty lot", () => {
    const r = sceneChanged([at("car", 0, 0)], [at("car", 0, 0), at("person", 300, 200)]);
    expect(r.changed).toBe(true);
    expect(r.reason).toContain("person");
  });

  it("sends when someone walks — same count, different place", () => {
    const before = [at("person", 100, 100)];
    const after = [at("person", 400, 120)];
    const r = sceneChanged(before, after);
    expect(r.changed).toBe(true);
    expect(r.reason).toContain("ตำแหน่ง");
  });

  it("does not send for an empty scene that stays empty", () => {
    expect(sceneChanged([], []).changed).toBe(false);
    // furniture is not part of the comparison at all
    expect(sceneChanged([at("chair", 0, 0)], [at("tv", 500, 0)]).changed).toBe(false);
  });

  it("ignores low-confidence flicker", () => {
    const before = [at("car", 0, 0)];
    const after = [at("car", 0, 0), at("person", 600, 300, 20, 40, 0.12)];
    expect(sceneChanged(before, after).changed).toBe(false);
    // ...but a confident person still counts
    const real = [at("car", 0, 0), at("person", 600, 300, 20, 40, 0.55)];
    expect(sceneChanged(before, real).changed).toBe(true);
  });

  it("treats a swap of two people at different desks as movement", () => {
    const before = [at("person", 0, 0), at("person", 500, 0)];
    const after = [at("person", 0, 0), at("person", 900, 0)];
    expect(sceneChanged(before, after).changed).toBe(true);
  });
});

describe("significant = something arrived (ADR-017 แก้ 2026-08-20)", () => {
  it("marks a person appearing where there was none as an arrival", () => {
    expect(sceneChanged([at("car", 0, 0)], [at("car", 0, 0), at("person", 300, 200)]).significant).toBe(true);
    expect(sceneChanged([], [at("person", 300, 200)]).significant).toBe(true);
  });

  it("does NOT treat one more of something already present as an arrival", () => {
    // 2026-08-28: this is what flooded the office again — with 5-8 people in
    // frame the detector count oscillates, so 4→5 fired every few seconds.
    const five = [at("person", 0, 0), at("person", 100, 0), at("person", 200, 0), at("person", 300, 0), at("person", 400, 0)];
    const six = [...five, at("person", 500, 0)];
    const r = sceneChanged(five, six);
    expect(r.changed).toBe(true);
    expect(r.significant).toBe(false);
    expect(sceneChanged([at("car", 0, 0)], [at("car", 0, 0), at("car", 200, 0)]).significant).toBe(false);
  });

  it("does NOT mark mere movement as an arrival — this is what flooded the office at 20s intervals", () => {
    const r = sceneChanged([at("person", 100, 100)], [at("person", 400, 120)]);
    expect(r.changed).toBe(true);
    expect(r.significant).toBe(false);
  });

  it("does NOT mark someone leaving as an arrival", () => {
    const r = sceneChanged([at("person", 0, 0), at("person", 500, 0)], [at("person", 0, 0)]);
    expect(r.changed).toBe(true);
    expect(r.significant).toBe(false);
  });

  it("an unchanged scene is neither changed nor significant", () => {
    const lot = [at("car", 0, 0), at("car", 200, 0)];
    const r = sceneChanged(lot, [at("car", 2, 1), at("car", 201, 0)]);
    expect(r.changed).toBe(false);
    expect(r.significant).toBe(false);
  });
});
