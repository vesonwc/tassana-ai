-- Dev/test seed only — never run against production.
-- One test site + two cameras per M1 spec.

insert into public.sites (id, name, site_key, mode, timezone)
values (
  '019889a0-0000-7000-8000-000000000001',
  'หมู่บ้านทดสอบ (dev)',
  'dev-site-key-please-rotate',
  'no_box',
  'Asia/Bangkok'
)
on conflict (site_key) do nothing;

insert into public.cameras (id, site_id, name, location_note, source_type, source_camera_ref)
values
  (
    '019889a0-0000-7000-8000-000000000101',
    '019889a0-0000-7000-8000-000000000001',
    'กล้องประตูหน้า',
    'ทางเข้าหลัก ฝั่งป้อมยาม',
    'hikvision_isapi',
    '1'
  ),
  (
    '019889a0-0000-7000-8000-000000000102',
    '019889a0-0000-7000-8000-000000000001',
    'กล้องรั้วหลัง',
    'แนวรั้วด้านหลังโครงการ',
    'hikvision_isapi',
    '2'
  )
on conflict (site_id, source_type, source_camera_ref) do nothing;
