-- ADR-011 profile #7: office interior — quiet by day, everything matters after
-- closing. Pairs with the listener's scheduled "night patrol" snapshots.

insert into public.camera_profiles (key, name_th, description_th, focus_events, severity_map, night_strict, vlm_prompt_th) values
(
  'office_afterhours',
  'สำนักงาน (เน้นหลังเลิกงาน)',
  'เวลางานพนักงานทำงาน = ปกติ ไม่รายงาน; หลังปิดออฟฟิศ: คนค้างอยู่ ไฟ/แอร์เปิดทิ้ง ประตูเปิดค้าง บุกรุก → รายงานทุกอย่าง',
  '["person_detected","intrusion","loitering"]',
  '{"intrusion":"critical","person_detected":"warning","loitering":"warning"}',
  true,
  'กล้องนี้เฝ้าพื้นที่ทำงานในสำนักงาน กติกาสำคัญที่สุด: ในช่วงเวลาทำการ พนักงานนั่งทำงาน เดินไปมา คุยกัน คือเรื่องปกติทั้งหมด ให้ verified=true severity=info และบรรยายสั้น ๆ ไม่ต้องยกเป็นเรื่องน่าสงสัย แต่นอกเวลาทำการ (ช่วงเฝ้าระวังเข้มข้น) ทุกอย่างมีความหมาย: (1) มีคนอยู่ในออฟฟิศ → warning ระบุจำนวนคนและกำลังทำอะไร ถ้าดูเหมือนไม่ใช่พนักงาน/กำลังค้นของ/ถือของออก → critical (2) ไฟหรือแอร์ยังเปิดอยู่ทั้งที่ไม่มีคน → แจ้ง verified=true severity=info พร้อมระบุว่า "ไฟเปิดทิ้งไว้" (3) ประตู/หน้าต่างเปิดค้าง → warning (4) ของหาย/ถูกเคลื่อนย้ายผิดปกติ/ตู้เปิด → warning ถ้าไม่มีคนและไฟปิดเรียบร้อย ให้บอกว่า "ออฟฟิศปิดเรียบร้อย" severity=info'
)
on conflict (key) do update set
  name_th = excluded.name_th,
  description_th = excluded.description_th,
  focus_events = excluded.focus_events,
  severity_map = excluded.severity_map,
  night_strict = excluded.night_strict,
  vlm_prompt_th = excluded.vlm_prompt_th;
