import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { analyzeSnapshot, type VlmAnalysis } from "../../lib/vlm";

// M3 accuracy harness. Drop images into testdata/images named by expectation:
//   person_xx.jpg, car_xx.jpg, motorcycle_xx.jpg  → should be verified=true
//   dog_xx.jpg, cat_xx.jpg, shadow_xx.jpg, rain_xx.jpg, empty_xx.jpg, tree_xx.jpg
//                                            → should be verified=false
// Run: npm run test:ai — prints per-image results and writes testdata/results.md

try {
  process.loadEnvFile(".env");
} catch {
  // optional
}

const IMAGE_DIR = "testdata/images";
const TRUE_PREFIXES = ["person", "car", "motorcycle", "truck", "intruder"];
const FALSE_PREFIXES = ["dog", "cat", "shadow", "rain", "empty", "tree", "light", "bird"];

interface TestResult {
  file: string;
  expected: boolean;
  analysis: VlmAnalysis | null;
  error: string | null;
  correct: boolean;
}

function expectedFor(file: string): boolean | null {
  const lower = file.toLowerCase();
  if (TRUE_PREFIXES.some((p) => lower.startsWith(p))) return true;
  if (FALSE_PREFIXES.some((p) => lower.startsWith(p))) return false;
  return null;
}

function mimeFor(file: string): string {
  return extname(file).toLowerCase() === ".png" ? "image/png" : "image/jpeg";
}

async function main(): Promise<void> {
  let files: string[];
  try {
    files = readdirSync(IMAGE_DIR).filter((f) =>
      [".jpg", ".jpeg", ".png"].includes(extname(f).toLowerCase()),
    );
  } catch {
    console.error(`No ${IMAGE_DIR} folder found. Create it and add images first.`);
    process.exit(1);
  }
  if (files.length === 0) {
    console.error(`No images in ${IMAGE_DIR}. Add .jpg/.png files named like person_01.jpg, dog_01.jpg`);
    process.exit(1);
  }

  const results: TestResult[] = [];
  for (const file of files) {
    const expected = expectedFor(file);
    if (expected === null) {
      console.log(`SKIP ${file} (unknown prefix — name it person_/dog_/shadow_/...)`);
      continue;
    }
    const base64 = readFileSync(join(IMAGE_DIR, file)).toString("base64");
    try {
      const analysis = await analyzeSnapshot(base64, mimeFor(file), {
        eventType: "unknown",
        cameraName: "กล้องทดสอบ",
        siteName: "ชุดทดสอบความแม่น",
      });
      const correct = analysis.verified === expected;
      results.push({ file, expected, analysis, error: null, correct });
      console.log(
        `${correct ? "✅" : "❌"} ${file} → verified=${analysis.verified} [${analysis.severity}] ${analysis.description_th}`,
      );
    } catch (err) {
      results.push({
        file,
        expected,
        analysis: null,
        error: (err as Error).message,
        correct: false,
      });
      console.log(`💥 ${file} → error: ${(err as Error).message}`);
    }
  }

  const total = results.length;
  const correct = results.filter((r) => r.correct).length;
  const falseAlarmsPassed = results.filter(
    (r) => !r.expected && r.analysis?.verified === true,
  ).length;
  const realMissed = results.filter(
    (r) => r.expected && r.analysis?.verified === false,
  ).length;
  const pct = total === 0 ? 0 : Math.round((correct / total) * 100);

  const summary = [
    `# ผลทดสอบความแม่น AI — ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
    "",
    `- โมเดล: ${results.find((r) => r.analysis)?.analysis?.model ?? "?"}`,
    `- ภาพทั้งหมด: ${total} | ถูก: ${correct} | **ความแม่น: ${pct}%**`,
    `- แจ้งเตือนหลอกที่หลุด (ควรกรองแต่บอกว่าจริง): ${falseAlarmsPassed}`,
    `- เหตุจริงที่พลาด (อันตรายสุด — ควรเป็น 0): ${realMissed}`,
    "",
    "| ภาพ | คาดหวัง | AI ตอบ | ผล | คำบรรยาย |",
    "|---|---|---|---|---|",
    ...results.map((r) =>
      r.analysis
        ? `| ${r.file} | ${r.expected ? "จริง" : "หลอก"} | ${r.analysis.verified ? "จริง" : "หลอก"} [${r.analysis.severity}] | ${r.correct ? "✅" : "❌"} | ${r.analysis.description_th} |`
        : `| ${r.file} | ${r.expected ? "จริง" : "หลอก"} | error | 💥 | ${r.error} |`,
    ),
    "",
  ].join("\n");

  writeFileSync("testdata/results.md", summary, "utf8");
  console.log(`\nความแม่นรวม: ${pct}% (${correct}/${total}) — รายละเอียดใน testdata/results.md`);
  if (realMissed > 0) {
    console.log(`⚠️ มีเหตุจริงที่ AI พลาด ${realMissed} ภาพ — ต้องจูน prompt ก่อนใช้จริง`);
  }
}

void main();
