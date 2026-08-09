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

## M2 — LINE แจ้งเตือน [สถานะ: ยังไม่เริ่ม]
- LINE client ใน /lib ส่งข้อความ + รูปเข้ากลุ่ม
- Worker โครงแรก (รัน local ก่อน): อ่านคิว → ส่ง LINE → บันทึก alerts
- **เสร็จเมื่อ:** curl ยิง event ปลอม → LINE กลุ่มทดสอบเด้งใน < 10 วินาที
- *ถึงจุดนี้ = เดโม่ให้คนดูได้แล้ว*

## M3 — Worker + VLM [สถานะ: ยังไม่เริ่ม]
- Deploy worker ขึ้น Railway
- Pipeline: อ่านคิว → โหลด snapshot → เรียก Gemini (กรองจริง/หลอก + severity + คำบรรยายไทย) → update events.ai → ส่ง/อัปเดต LINE
- Fail-open: VLM timeout 20 วิ → ส่ง alert ดิบทันที
- **เสร็จเมื่อ:** ทดสอบชุดภาพจริง 20-30 ภาพ (คน/หมา/เงา/ฝน) แล้วบันทึกผล % ความถูกต้องลงไฟล์นี้

## M4 — Dashboard [สถานะ: ยังไม่เริ่ม]
- Login ด้วย Supabase Auth
- หน้า event ย้อนหลัง (filter วัน/กล้อง/ประเภท), ดูภาพ/คลิป, ปุ่ม "แจ้งเท็จ"
- หน้า admin ของเรา: เห็นทุกไซต์ + heartbeat status
- **เสร็จเมื่อ:** กด "แจ้งเท็จ" แล้ว alerts.feedback อัปเดตจริง

## M5 — รายงานเช้า [สถานะ: ยังไม่เริ่ม]
- Cron 06:00 บน worker: ดึงสถิติเมื่อวาน → Claude เขียนสรุปไทย → PDF → ส่ง LINE นิติ
- เนื้อหา: รถเข้า-ออก, เหตุผิดปกติ + ภาพ, กล้อง offline ช่วงไหน
- **เสร็จเมื่อ:** รายงานเด้งเข้า LINE ตรงเวลา 3 วันติด

## M6 — กล้องจริง + heartbeat [สถานะ: ยังไม่เริ่ม]
- ต่อกล้อง Hikvision/Dahua จริง 1 ตัว (ที่บ้าน) ยิง event เข้าระบบ
- Heartbeat: กล้อง/ไซต์เงียบเกิน 10 นาที → event camera_offline → แจ้ง LINE
- รัน 7 วัน จดจำนวน alert หลอกต่อวัน จูนจนเหลือหลักหน่วย
- **เสร็จเมื่อ:** ระบบนิ่ง 7 วัน → พร้อมหาไซต์นำร่อง

## หลัง MVP (ยังไม่ทำ — จดไว้กันลืม)
- Frigate adapter (โหมดกล่อง Edge) / LPR + ฐานทะเบียนรถ / รายงานรายเดือน
- ระบบ billing / หน้า onboarding ไซต์ใหม่แบบ self-serve
