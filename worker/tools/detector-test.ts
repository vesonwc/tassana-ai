import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { cropForVlm, detectObjects, detectorDisabledReason, loadDetectorNow, DETECTOR_MODE, MODEL_PATH } from "../detector";
import { buildDetectorHint, decideGate, summarizeLabels } from "../../lib/detector-core";

// ADR-015 local harness: run the detector over a folder of snapshots and show
// what gate mode would do with each. No Gemini calls, no Supabase.
//   npx tsx worker/tools/detector-test.ts [folder] [eventType]
// Crops that would be attached to the VLM are written to testdata/detector-out/.

try {
  process.loadEnvFile(".env");
} catch {
  // optional
}

const folder = process.argv[2] ?? "testdata/images";
const eventType = process.argv[3] ?? "unknown";
const OUT_DIR = "testdata/detector-out";

async function main(): Promise<void> {
  if (!(await loadDetectorNow())) {
    console.error(`detector load failed: ${detectorDisabledReason()}`);
    process.exit(1);
  }
  if (!existsSync(folder)) {
    console.error(`folder not found: ${folder}`);
    process.exit(1);
  }
  const files = readdirSync(folder).filter((f) =>
    [".jpg", ".jpeg", ".png"].includes(extname(f).toLowerCase()),
  );
  if (files.length === 0) {
    console.error(`no images in ${folder}`);
    process.exit(1);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`detector-test: ${files.length} images from ${folder}, model=${MODEL_PATH}, YOLO_MODE=${DETECTOR_MODE}\n`);

  let analyzed = 0;
  let wouldSkip = 0;
  let failed = 0;
  let totalMs = 0;
  const lines: string[] = [];
  for (const file of files) {
    const buf = readFileSync(join(folder, file));
    const run = await detectObjects(buf);
    if (!run) {
      failed += 1;
      const why = detectorDisabledReason() ?? "timeout";
      console.log(`⚠️  ${file} → detector unavailable (${why}) → fail-open: Gemini`);
      lines.push(`| ${file} | — | error: ${why} | analyze (fail-open) |`);
      continue;
    }
    totalMs += run.ms;
    // Judge as gate mode regardless of env so the harness answers "what would happen".
    const gate = decideGate({ mode: "gate", eventType, detections: run.detections });
    if (gate.action === "skip") wouldSkip += 1;
    else analyzed += 1;
    const crop = gate.action === "analyze" ? await cropForVlm(buf, run) : null;
    if (crop) {
      writeFileSync(join(OUT_DIR, `${file.replace(/\.[^.]+$/, "")}_crop.jpg`), Buffer.from(crop.base64, "base64"));
    }
    const summary = summarizeLabels(run.detections);
    console.log(
      `${gate.action === "skip" ? "⏭️ " : "🔍"} ${file} (${run.width}x${run.height}, ${run.ms}ms) → ${summary} → ${gate.action} [${gate.reason}]${crop ? ` +crop ${crop.box.w}x${crop.box.h}` : ""}`,
    );
    for (const d of run.detections.slice(0, 8)) {
      console.log(`     ${d.label} ${d.confidence.toFixed(2)} @ ${Math.round(d.box.x)},${Math.round(d.box.y)} ${Math.round(d.box.w)}x${Math.round(d.box.h)}`);
    }
    if (gate.action === "analyze") console.log(`     hint: ${buildDetectorHint(run.detections)}`);
    lines.push(`| ${file} | ${run.ms} | ${summary} | ${gate.action} |`);
  }

  const n = analyzed + wouldSkip;
  console.log(
    `\nsummary: ${n} detected ok, ${failed} failed | would send to Gemini ${analyzed}, would skip ${wouldSkip}` +
      (n ? ` (${Math.round((wouldSkip / n) * 100)}% saved), avg ${Math.round(totalMs / n)}ms` : ""),
  );
  writeFileSync(
    join(OUT_DIR, "results.md"),
    [`# detector-test ${new Date().toISOString()}`, "", `folder: ${folder}, eventType: ${eventType}`, "", "| file | ms | detections | gate |", "|---|---|---|---|", ...lines].join("\n"),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
