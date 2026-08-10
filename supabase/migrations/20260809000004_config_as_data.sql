-- ADR-011: configuration as data — camera profiles, site templates,
-- per-camera enable switch and natural-language instructions.

-- ---------------------------------------------------------- camera_profiles
create table public.camera_profiles (
  id             uuid primary key default gen_random_uuid(),
  key            text not null unique,
  name_th        text not null,
  description_th text not null default '',
  focus_events   jsonb not null default '[]'::jsonb,   -- event types this role cares about
  severity_map   jsonb not null default '{}'::jsonb,   -- event_type -> info|warning|critical
  night_strict   boolean not null default false,       -- treat strict-hours activity as more severe
  vlm_prompt_th  text not null default '',             -- role-specific instructions for the VLM
  created_at     timestamptz not null default now()
);

alter table public.camera_profiles enable row level security;
create policy "authenticated read camera_profiles"
  on public.camera_profiles for select to authenticated using (true);

-- ---------------------------------------------------------- site_templates
create table public.site_templates (
  id             uuid primary key default gen_random_uuid(),
  key            text not null unique,
  name_th        text not null,
  description_th text not null default '',
  playbook       jsonb not null default '{}'::jsonb,   -- accumulated field lessons
  created_at     timestamptz not null default now()
);

alter table public.site_templates enable row level security;
create policy "authenticated read site_templates"
  on public.site_templates for select to authenticated using (true);

-- ---------------------------------------------------------- new columns
alter table public.cameras
  add column enabled boolean not null default true,
  add column profile_id uuid references public.camera_profiles(id) on delete set null,
  add column custom_instructions_th text;

alter table public.sites
  add column template_id uuid references public.site_templates(id) on delete set null,
  add column custom_instructions_th text;

-- ---------------------------------------------------------- seed: 6 profiles
insert into public.camera_profiles (key, name_th, description_th, focus_events, severity_map, night_strict, vlm_prompt_th) values
(
  'gate',
  'ประตูเข้า-ออก',
  'รถเข้าออก + อ่านทะเบียน, คนเดินเข้าช่วงเวลาต้องห้าม',
  '["vehicle_detected","lpr","person_detected","line_crossing"]',
  '{"intrusion":"critical","line_crossing":"warning","person_detected":"info","vehicle_detected":"info","lpr":"info"}',
  true,
  'กล้องนี้เฝ้าประตูเข้า-ออกหลัก สนใจ: รถทุกคันที่เข้า-ออก (ระบุชนิด สี และป้ายทะเบียนถ้าอ่านได้), คนเดินเท้าที่เข้ามา โดยเฉพาะช่วงเวลาเฝ้าเข้มให้ถือว่าน่าสงสัยกว่าปกติ, พฤติกรรมแอบตาม (คน/รถลอดตามคันหน้าโดยไม่หยุดแลกบัตร)'
),
(
  'fence',
  'รั้ว/แนวเขต',
  'ข้ามเส้น ปีนรั้ว เข้มข้นพิเศษช่วงกลางคืน',
  '["line_crossing","intrusion","person_detected","loitering"]',
  '{"intrusion":"critical","line_crossing":"critical","loitering":"warning","person_detected":"warning"}',
  true,
  'กล้องนี้เฝ้าแนวรั้ว/เขตหวงห้าม พื้นที่นี้ปกติต้องไม่มีคน ทุกการปรากฏตัวของคนคือเหตุต้องสนใจ โดยเฉพาะ: การปีน/ข้ามรั้ว, การยืนสังเกตการณ์แนวรั้วนาน ๆ, การส่งของข้ามรั้ว ช่วงกลางคืนให้ยกระดับความร้ายแรงขึ้นหนึ่งขั้นเสมอ'
),
(
  'common_area',
  'พื้นที่ส่วนกลาง',
  'สระ/ฟิตเนส/สนามเด็กเล่น — เน้นอุบัติเหตุและคนล้ม',
  '["person_detected","loitering"]',
  '{"person_detected":"info","loitering":"info","intrusion":"warning"}',
  false,
  'กล้องนี้เฝ้าพื้นที่ส่วนกลาง (สระว่ายน้ำ/ฟิตเนส/สนามเด็กเล่น) เป้าหมายหลักคือความปลอดภัยของผู้ใช้งาน ไม่ใช่การบุกรุก: ระวังเป็นพิเศษ คนล้มแล้วไม่ลุก, เด็กอยู่ใกล้น้ำโดยไม่มีผู้ใหญ่, การเล่นที่เสี่ยงอันตราย, คนใช้งานนอกเวลาเปิดบริการ'
),
(
  'parking',
  'ลานจอดรถ',
  'รถจอดผิดที่ จอดขวาง คนวนเวียนแถวรถนานผิดปกติ',
  '["vehicle_detected","person_detected","loitering","lpr"]',
  '{"loitering":"warning","vehicle_detected":"info","person_detected":"info"}',
  true,
  'กล้องนี้เฝ้าลานจอดรถ สนใจ: รถจอดขวางทางหรือจอดในที่ห้ามจอด, คนเดินวนดูรถหลายคันหรือชะโงกดูในรถ (พฤติกรรมโจรกรรม), การเฉี่ยวชนแล้วขับหนี ช่วงกลางคืนคนเดินในลานจอดที่ไม่ได้ตรงไปยังรถคันใดคันหนึ่งถือว่าน่าสงสัย'
),
(
  'guard_post',
  'จุดทำงาน (ป้อมยาม/เคาน์เตอร์)',
  'ตรวจว่ามีคนประจำจุดจริง จุดว่างนานผิดปกติให้แจ้ง',
  '["person_detected"]',
  '{"person_detected":"info"}',
  false,
  'กล้องนี้เฝ้าจุดปฏิบัติงานที่ต้องมีเจ้าหน้าที่ประจำ สิ่งที่ต้องรายงาน: จุดว่างไม่มีเจ้าหน้าที่, เจ้าหน้าที่หลับ, มีคนแปลกหน้าเข้ามาในจุดทำงานโดยไม่มีเจ้าหน้าที่อยู่'
),
(
  'building_access',
  'ทางเข้าอาคาร/ลิฟต์/ทางหนีไฟ',
  'ของวางขวางทางหนีไฟ คนเดินเตร่หน้าทางเข้า',
  '["person_detected","loitering","intrusion"]',
  '{"loitering":"warning","intrusion":"warning","person_detected":"info"}',
  true,
  'กล้องนี้เฝ้าทางเข้าอาคาร/โถงลิฟต์/ทางหนีไฟ สนใจ: สิ่งของถูกวางขวางทางหนีไฟหรือประตูฉุกเฉิน (ต้องแจ้งเสมอ), คนเดินเตร่หรือรอเกาะติดคนอื่นเพื่อตามเข้าประตู (tailgating), ประตูถูกเปิดค้าง'
);

-- ---------------------------------------------------------- seed: 4 templates
insert into public.site_templates (key, name_th, description_th, playbook) values
('village_standard', 'หมู่บ้านมาตรฐาน', 'หมู่บ้านจัดสรร มีป้อมยาม รั้วรอบ',
 '{"suggested_profiles":["gate","fence","guard_post","common_area"],"notes_th":"เริ่มจากประตูเข้าออก + รั้วด้านเปลี่ยว ก่อนขยายไปส่วนกลาง"}'),
('condo_lowrise', 'คอนโด Low-rise', 'ตึก 8 ชั้นลงมา ลิฟต์น้อย ทางเข้าจำกัด',
 '{"suggested_profiles":["building_access","parking","common_area"],"notes_th":"ทางเข้าอาคารสำคัญสุด รองลงมาคือลานจอด"}'),
('condo_highrise', 'คอนโด High-rise', 'ตึกสูง ลิฟต์หลายตัว คนพลุกพล่าน',
 '{"suggested_profiles":["building_access","parking","common_area","guard_post"],"notes_th":"เน้น tailgating ที่ลิฟต์และทางหนีไฟ"}'),
('security_firm', 'ไซต์ รปภ.', 'บริษัทรักษาความปลอดภัยดูแลหลายจุด',
 '{"suggested_profiles":["guard_post","gate","fence"],"notes_th":"จุดทำงานว่าง = ความเสี่ยงหลักของสัญญา รปภ."}');
