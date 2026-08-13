# Roadmap (อัปเดตสถานะทุกครั้งที่จบงาน)

กติกา: ทำทีละ milestone จบ → commit → ติ๊กสถานะ → ค่อยเริ่มอันถัดไป
ห้ามเปิดสอง milestone พร้อมกัน

## M0 — โครงพื้นฐาน deploy ผ่าน [สถานะ: ✅ เสร็จ 2026-08-09]
- [x] Next.js app (App Router, TypeScript) + `npm run build` ผ่าน
- [x] `.env.example` + `.gitignore` (`.env` ไม่เข้า git)
- [x] git init + commit
- [x] GitHub: https://github.com/vesonwc/tassana-ai (private) + Vercel: https://tassana-ai.vercel.app (team pontunjai, Hobby)
- [x] Supabase project จริง (บัญชีธุรกิจใหม่) — schema apply ผ่าน SQL Editor
- [x] .env ครบทั้ง local และ Vercel (3 ตัว: URL, publishable, secret)
- [x] **เสร็จเมื่อ:** push แล้วเว็บอัปเดตอัตโนมัติ ✅, `npm run dev` รันผ่าน ✅, webhook โปรดักชันทดสอบผ่าน (201/ซ้ำ/401)

## M1 — Schema + Webhook receiver [สถานะ: ✅ เสร็จ 2026-08-09]
- [x] Migration สร้างตาราง sites, cameras, events, alerts, reports + pgmq queue (`supabase/migrations/20260809000001_init_schema.sql`)
- [x] `POST /api/webhook/[siteKey]` ตรวจ siteKey (ผิด → 401) → normalize → insert idempotent → enqueue pgmq
- [x] Event normalizer hikvision_isapi (`lib/normalizers/hikvision.ts`) + dispatch (`lib/normalize.ts`)
- [x] Seed site ทดสอบ 1 แห่ง กล้อง 2 ตัว (`supabase/seed.sql`)
- [x] Test 18 ข้อผ่าน (2026-08-09): normalizer ดี/เสีย/ไม่รู้จัก/ซ้ำ + webhook 401/400/duplicate
- [x] **เสร็จเมื่อ:** ยิง payload ปลอมด้วย curl → เห็นแถวใหม่ในตาราง events ถูกต้องทุก field ✅ ทดสอบผ่านกับ Supabase จริง 2026-08-09 (valid→201, ซ้ำ→200 ไม่สร้างแถวใหม่, siteKey ผิด→401, camera_id resolve ถูกทั้ง 2 กล้อง, heartbeat อัปเดต, enqueue pgmq ไม่มี error)
- หมายเหตุ: migration แรก apply ผ่าน SQL Editor (ยังไม่ได้ `supabase link` CLI — ค่อยทำตอนต้องการ migration ถัดไป)

## M1.5 — หน้าดู event ชั่วคราว (แทรกตามคำขอเจ้าของ 2026-08-09) [สถานะ: ✅ เสร็จ 2026-08-09]
- เจ้าของยังไม่อยากทำ LINE — ขอแค่ "เห็น event เองได้" ก่อน จึงแทรกหน้านี้ แล้วเลื่อน M2 ออกไป
- หน้า `/admin/<ADMIN_DASH_KEY>/events` แสดง 50 event ล่าสุดภาษาไทย (กันคนนอกด้วย secret ใน path — auth จริงมาใน M4)

## M2 — LINE แจ้งเตือน [สถานะ: ✅ เสร็จ 2026-08-13]
- [x] `lib/line.ts` Flex message (รูป + severity + คำบรรยาย + ปุ่มดูในระบบ) + รายงานเช้า text
- [x] Worker คลาวด์ส่งเอง: กรองตามกฎไซต์ (ประเภทที่ติ๊ก + ความไว low/medium/high) → push → บันทึก alerts.sent_at
- [x] รายงานเช้า 06:00 อัตโนมัติ (กันซ้ำด้วยตาราง reports) + webhook จับ chat id + ช่องตั้งปลายทางในแท็บ 🔌
- [x] **เสร็จเมื่อ:** ยิง event ปลอม → LINE เด้งจริง ✅ 2026-08-13 19:05 (ส่งโดย Railway worker ทั้งเส้น ผ่านรอบ retry อัตโนมัติ)
- *เดโม่ให้คนดูได้แล้วจริง ๆ*
- [x] **Seamless upgrade 2026-08-13:** alert-first (บุกรุก/ข้ามเส้น → LINE ดิบใน ~1.5 วิ ผ่าน webhook, AI verdict ตามใน ~5 วิ รวมข้อความ "ตรวจแล้วน่าจะหลอก" ช่วยคลายใจ) + realtime wake (migration 0006) + สลับ lite model นำบนแพ็กฟรี — วัดจริง: 3.5 นาที → 1.5/5 วิ โดยยังไม่เปิด billing ใด ๆ; บทเรียน: Vercel มีโปรเจกต์ซ้ำ tassana-ai-26mx ที่ผู้ใช้ควรลบ

## M3 — Worker + VLM [สถานะ: โค้ดเสร็จ 2026-08-09 — รอ GEMINI_API_KEY + รัน SQL migration 0002 + ทดสอบจริง]
- แผนปรับ: ใช้ DJI Pocket 3 (โหมดเว็บแคม) + PC agent เป็นกล้องทดสอบแทนกล้อง CCTV จริงไปก่อน (กล้องบ้านเจ้าของเป็น LifeSmart ระบบปิด ต่อไม่ได้); worker รัน local ก่อน ค่อย deploy Railway
- [x] `lib/vlm.ts` Gemini client (REST, timeout 20 วิ, ตอบ JSON: verified/severity/description_th/label)
- [x] `worker/index.ts` pipeline: pgmq → โหลด snapshot จาก Storage → Gemini → update events.ai; fail-open: ล้มเกิน 3 ครั้ง → ปล่อย event ดิบ + ack
- [x] `worker/agent/capture.ts` PC agent: ffmpeg จับเฟรม Pocket 3 → ตรวจ motion (pixel diff) → อัปโหลดภาพ + ยิง webhook (`npm run agent:pocket3`)
- [x] Manual adapter (`lib/normalizers/manual.ts`) + test รวม 22 ข้อผ่าน; bucket `snapshots` + กล้อง pocket3 สร้างแล้ว
- [x] รัน migration 0002 (dequeue/ack) + GEMINI_API_KEY (key รูปแบบใหม่ `AQ.` ใช้ได้; model = `gemini-flash-latest` กันรุ่นถูกปิด)
- [x] **E2E ผ่านครั้งแรก 2026-08-09 14:42** — กล้องโน้ตบุ๊ก (Pocket 3 รอสายข้อมูล): motion → upload → webhook → คิว → Gemini → "พบชายสวมแว่นตากำลังดื่มน้ำจากแก้ว..." ขึ้นหน้า /admin; retry อัตโนมัติพิสูจน์แล้ว (event แรกล้มเพราะชื่อรุ่น → คิวส่งซ้ำ → สำเร็จ ไม่มี event หาย)
- [x] สลับ agent เป็น Pocket 3 สำเร็จ 2026-08-09 16:03 — ffmpeg เห็น "OsmoPocket3", E2E ผ่าน (motion → คลาวด์วิเคราะห์ → "พบชายสวมแว่นตาและเสื้อยืดสีเข้ม ถือถุงสิ่งของ...") ภาพคมขึ้น คำบรรยายละเอียดขึ้นชัดเจน
- [x] **Deploy worker ขึ้น Railway สำเร็จ 2026-08-09 15:14** — trial account (บัญชี GitHub vesonwc), region EU West, พิสูจน์แล้ว: ปิดทุกอย่างในเครื่อง → ยิง event → worker คลาวด์วิเคราะห์เอง (บทเรียน: ต้อง pin Node>=22 ใน engines และห้ามตั้ง buildCommand ซ้ำกับ install phase ของ Nixpacks — EBUSY cache mount)
- หมายเหตุ: เหลือส่วนเดียวที่รันในเครื่องคือ capture agent (ผูกกับกล้อง USB โดยธรรมชาติ — หมดความจำเป็นเมื่อต่อ NVR จริงใน M6)
- **เสร็จเมื่อ:** ทดสอบชุดภาพจริง 20-30 ภาพ (คน/หมา/เงา/ฝน) แล้วบันทึกผล % ความถูกต้องลงไฟล์นี้

## M4 — Dashboard [สถานะ: ✅ เสร็จ 2026-08-09 (รอผู้ใช้ล็อกอินครั้งแรกยืนยัน UX)]
- [x] Login ด้วย Supabase Auth (email+password, ไม่มี self-signup — ADR-010) + middleware กัน /dashboard
- [x] หน้ารวมทุกโครงการ: การ์ดสถานะเขียว/แดงจาก heartbeat + จำนวน event วันนี้ — รองรับหลายโครงการผ่าน profiles (admin เห็นหมด / site_user เห็นเฉพาะของตัว, RLS บังคับระดับแถว)
- [x] หน้า event ย้อนหลัง: filter วัน/กล้อง/ประเภท, ภาพ snapshot (signed URL 1 ชม.), คำบรรยาย AI, ปุ่มแจ้งเท็จ/เหตุจริง
- [x] หน้าตั้งค่ากฎต่อโครงการ (sites.rules): toggle แจ้งเตือน 7 ประเภท + ช่วงเวลาเฝ้าเข้ม + ความไว — worker/LINE จะอ่านกฎนี้ตอน M2
- [x] บัญชี admin แรกสร้างแล้ว (veson.wc@gmail.com) — ทดสอบ login + RLS ผ่าน API ผ่าน
- [x] **เสร็จเมื่อ:** กด "แจ้งเท็จ" แล้ว alerts.feedback อัปเดตจริง — พิสูจน์แล้วบนหน้า /admin (โค้ดเส้นทางเดียวกัน); รอผู้ใช้กดบน dashboard ยืนยันอีกชั้น

## M5 — รายงานเช้า [สถานะ: ทำส่วนแรกแล้ว — หน้าสถิติรายวันใน dashboard (2026-08-09); เหลือ Claude สรุปไทย + PDF + ส่ง LINE 06:00]
- [x] หน้า `/dashboard/sites/[id]/report`: สถิติวันนี้/เมื่อวาน แยกตามประเภท + AI จริง/หลอก + กล้องขาดการติดต่อ
- Cron 06:00 บน worker: ดึงสถิติเมื่อวาน → Claude เขียนสรุปไทย → PDF → ส่ง LINE นิติ
- เนื้อหา: รถเข้า-ออก, เหตุผิดปกติ + ภาพ, กล้อง offline ช่วงไหน
- **เสร็จเมื่อ:** รายงานเด้งเข้า LINE ตรงเวลา 3 วันติด

## M6 — กล้องจริง + heartbeat [สถานะ: ยังไม่เริ่ม]
- ต่อกล้อง Hikvision/Dahua จริง 1 ตัว (ที่บ้าน) ยิง event เข้าระบบ
- Heartbeat: กล้อง/ไซต์เงียบเกิน 10 นาที → event camera_offline → แจ้ง LINE
- รัน 7 วัน จดจำนวน alert หลอกต่อวัน จูนจนเหลือหลักหน่วย
- **เสร็จเมื่อ:** ระบบนิ่ง 7 วัน → พร้อมหาไซต์นำร่อง

## Configuration as Data (ADR-011, แทรกตามวิชั่นเจ้าของ) [สถานะ: โค้ดเสร็จ 2026-08-09 ค่ำ — รอรัน migration 0004]
- [x] กฎ 3 ชั้น: พื้นฐาน (ฝังใน prompt ปิดไม่ได้) / โปรไฟล์กล้อง 6 แบบ (ตาราง camera_profiles) / คำสั่งภาษาไทยต่อกล้อง+ต่อไซต์
- [x] site_templates 4 แม่แบบ, cameras.enabled สวิตช์รายตัว (ปิด = เก็บ event ไม่วิเคราะห์), UI ตั้งค่ารายกล้องในหน้า settings
- [x] test prompt 3 ชั้น (28 ข้อรวมผ่าน)
- [ ] รัน `supabase/migrations/20260809000004_config_as_data.sql` ใน SQL Editor

## ปิดลูปแพลตฟอร์ม (แทรก 2026-08-09 ดึก ตามการวิเคราะห์ "คิดให้ครบลูป") [สถานะ: โค้ดเสร็จ — รอรัน migration 0004+0005]
- [x] Onboarding admin: หน้าเปิดโครงการใหม่ (เลือกแม่แบบ+สร้าง siteKey), หน้าเชื่อมกล้อง (webhook URL + คู่มือ Hikvision + rotate key), หน้าเพิ่มผู้ใช้ (สุ่มรหัสผ่านให้)
- [x] กล้อง auto-register: event แรกจากช่องที่ไม่รู้จัก → สร้างรายการกล้องเอง สถานะปิด รอเปิดสวิตช์ (ADR-011)
- [x] Heartbeat รายกล้อง (last_event_at) — กล้องเดียวดับท่ามกลางกล้องอื่นที่ยังทำงาน ระบบเห็น
- [x] Retention 60 วัน + เก็บ event ที่มี feedback ถาวรแบบไม่มีรูป (ADR-012), dead-man switch ของ worker + แถบเตือนบน dashboard
- [x] คุณภาพรายกล้อง 7 วันในหน้ารายงาน (% แจ้งหลอก → รู้ว่ากล้องไหนควรจูน) + docs/costs.md ต้นทุนต่อหน่วย
- [ ] สิ่งที่ user ต้องทำ: รัน migration 0004 + 0005 ใน SQL Editor / อัป Railway เป็น Hobby ก่อน trial หมด (~ต้นก.ย.) / เปิด billing Gemini ก่อนไซต์นำร่อง
- ช่องว่างใหญ่ที่เหลือ: **M2 LINE** (ลูป event→คน ยังต้องเปิดเว็บเอง), Hikvision XML จริง (M6)

## ชั้นที่ 4 — ความรู้ที่ระบบถามสะสมเอง (ADR-013) [สถานะ: ✅ เสร็จ 2026-08-13 ดึก]
- [x] VLM ตอบ uncertain + ตั้งคำถามไทยเอง → ส่งเข้า LINE พร้อมภาพ
- [x] ตอบใน LINE = สอนถาวร (site_knowledge) + บอทยืนยันกลับ; แนบเข้า prompt ชั้นที่ 4 ทุกภาพ
- [x] แท็บ 🧠 ความรู้: ดู/เพิ่ม/ลบ
- [x] **E2E จริงผ่าน:** ผู้ใช้ตอบคำถามแรก → ระบบรู้จัก "บองกี้" สุนัขชิวาว่าของบ้าน ✅

## หลัง MVP (ยังไม่ทำ — จดไว้กันลืม)
- Frigate adapter (โหมดกล่อง Edge) / LPR + ฐานทะเบียนรถ / รายงานรายเดือน
- ระบบ billing / หน้า onboarding ไซต์ใหม่แบบ self-serve
