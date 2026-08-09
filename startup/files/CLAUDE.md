# CCTV AI Platform

แพลตฟอร์มเฝ้าระวังอัจฉริยะสำหรับหมู่บ้าน/คอนโด/งานรปภ. ในไทย
รับ event จากกล้อง/NVR เดิมของลูกค้า → กรองและบรรยายด้วย VLM → แจ้งเตือน LINE → สรุปรายงานอัตโนมัติ
**ไม่เปลี่ยนกล้องลูกค้า ไม่บังคับซื้อฮาร์ดแวร์** (กล่อง Edge เป็น upsell ภายหลัง)

## Stack (ห้ามเปลี่ยนโดยไม่บันทึกลง docs/decisions.md)

- **ภาษา:** TypeScript ทั้งระบบ (ไม่มี Python ใน MVP)
- **หน้าบ้าน + webhook receiver:** Next.js (App Router) บน Vercel
- **ฐานข้อมูล/ไฟล์/Auth/คิว:** Supabase (Postgres + Storage + Auth + pgmq)
- **Worker:** Node/TypeScript container บน Railway — งานที่รันยาว: ดึงคลิป, เรียก VLM, cron รายงาน, heartbeat
- **AI:** Gemini (วิเคราะห์ภาพ/กรอง event) + Claude (สรุปรายงานภาษาไทย) — เรียกผ่าน API เท่านั้น
- **แจ้งเตือน:** LINE Messaging API
- **เชื่อมไซต์ลูกค้า:** Tailscale เท่านั้น — **ห้ามให้ลูกค้า port forward NVR เด็ดขาด**

## กติกาเหล็ก

1. **ทุก event ต้องผ่าน schema กลางใน `docs/event-schema.md`** — ห้ามสร้าง format ใหม่ ห้าม adapter เขียนลงตารางตรง ๆ ต้องแปลงเป็น NormalizedEvent ก่อนเสมอ
2. **ห้าม hardcode secret** — ใช้ `.env` / environment variables เท่านั้น และ `.env` ต้องอยู่ใน `.gitignore`
3. **Fail-open ไม่ fail-silent** — ถ้า VLM ล่มหรือช้าเกิน 20 วินาที ให้ส่งแจ้งเตือนดิบ (ไม่มีคำบรรยาย) ไปก่อน ห้ามเงียบ
4. **ไม่มี face recognition ใน v1** (เหตุผล PDPA — ดู decisions.md ADR-004)
5. **UI และข้อความแจ้งเตือนเป็นภาษาไทย** โค้ด/comment เป็นอังกฤษ
6. เสร็จงานทุกชิ้นให้ commit พร้อมข้อความสั้น ๆ และอัปเดตสถานะใน `docs/roadmap.md`
7. การตัดสินใจเชิงสถาปัตยกรรมใหม่ทุกครั้ง → เพิ่ม ADR ใน `docs/decisions.md` ก่อนเขียนโค้ด

## เอกสารที่ต้องอ่านก่อนทำงานใหญ่

- `docs/architecture.md` — ภาพรวมระบบสองโหมด (ไร้กล่อง / มีกล่อง Edge)
- `docs/event-schema.md` — โครงสร้าง event กลาง + ตาราง DB (สำคัญที่สุด)
- `docs/roadmap.md` — milestone ปัจจุบันและเกณฑ์ว่า "เสร็จ" คืออะไร
- `docs/decisions.md` — เหตุผลเบื้องหลังทุกการตัดสินใจ

## คำสั่งที่ใช้บ่อย

```bash
npm run dev          # รัน Next.js local
npm run worker:dev   # รัน worker local
npx supabase db push # apply migration ขึ้น Supabase
npm test             # รัน test (webhook receiver + event normalizer ต้องมี test เสมอ)
```

## โครงสร้างโปรเจกต์

```
/app                 # Next.js — หน้าเว็บ + API routes
  /api/webhook/[siteKey]/route.ts   # จุดรับ event จาก NVR/กล้อง
/worker              # โค้ด worker (deploy แยกไป Railway)
/lib                 # โค้ดแชร์: types, event normalizer, LINE client, VLM client
/supabase/migrations # SQL migrations
/docs                # เอกสารสมองของโปรเจกต์
```
