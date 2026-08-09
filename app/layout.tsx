import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Tassana AI — แพลตฟอร์มเฝ้าระวังอัจฉริยะ",
  description:
    "รับ event จากกล้อง/NVR เดิมของลูกค้า กรองด้วย AI แจ้งเตือน LINE สรุปรายงานอัตโนมัติ",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="th">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0 }}>
        {children}
      </body>
    </html>
  );
}
