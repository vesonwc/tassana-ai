-- ADR-011 layer 2 fix: the parking profile asked the VLM to judge "blocking the
-- driveway" / "parked where parking is forbidden". The model cannot know a
-- site's layout, so it guessed — 7 of 9 warnings over three days were ordinary
-- parked cars. Site-specific rules belong in layer 3 (custom_instructions_th),
-- not in a shared profile.
--
-- Measured 2026-08-18: re-judging the 10 flagged events with this text turned 7
-- into "info" while keeping the genuine night-time ones as warning.

update public.camera_profiles
set vlm_prompt_th = 'กล้องนี้เฝ้าลานจอดรถ สิ่งต่อไปนี้คือเรื่องปกติของลานจอดรถ ห้ามยกเป็นเหตุน่าสงสัยเด็ดขาด: รถจอดเรียงกันเต็มลานหรือจอดกระจาย, รถเข้า-ออกหรือถอยเข้าช่องจอด, คนเดินไปขึ้นรถ ลงจากรถ หรือขนของขึ้น-ลงรถ, รถจอดค้างข้ามคืนในลานของหน่วยงานเอง — กรณีเหล่านี้ให้ verified=true severity=info และบรรยายสั้น ๆ พอ สิ่งที่ต้องสนใจจริง: (1) คนเดินวนดูรถหลายคัน ชะโงกมองในรถ ลองดึงมือจับประตู หรือก้มดูใต้รถ (พฤติกรรมโจรกรรม) ให้ warning (2) เฉี่ยวชนแล้วขับออกไป ให้ warning (3) มีคนอยู่ในลานจอดนอกเวลาทำการโดยไม่ได้เดินตรงไปยังรถคันใดคันหนึ่ง ให้ warning (4) รถถูกงัด กระจกแตก ล้อถูกถอด หรือมีคนขนของออกจากรถคันอื่น ให้ critical ข้อห้ามสำคัญ: อย่าตัดสินว่า "จอดขวางทาง" หรือ "จอดในที่ห้ามจอด" จากภาพเพียงอย่างเดียว เพราะคุณไม่รู้ผังลานจอดและช่องทางเข้า-ออกของไซต์นี้ ให้แจ้งเรื่องนี้เฉพาะเมื่อผู้ดูแลเขียนไว้ในคำสั่งเพิ่มเติม หรือเมื่อเห็นชัดเจนจริง ๆ ว่ารถขวางประตู ทางหนีไฟ หรือทางลาด จนรถหรือคนอื่นผ่านไม่ได้',
    description_th = 'คนวนเวียนแถวรถผิดปกติ รถถูกงัด คนอยู่ในลานนอกเวลาทำการ'
where key = 'parking';
