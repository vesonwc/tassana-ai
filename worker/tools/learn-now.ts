// One-shot: run the daily baseline learner immediately (ADR-014).
// Usage: npx tsx worker/tools/learn-now.ts
process.env.LEARN_BASELINES_ON_START = "1";
process.env.LEARN_ONLY = "1";
import("../index").catch((err) => {
  console.error(err);
  process.exit(1);
});
