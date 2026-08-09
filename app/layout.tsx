import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Anuphan } from "next/font/google";

const anuphan = Anuphan({
  subsets: ["thai", "latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "Tassana AI — แพลตฟอร์มเฝ้าระวังอัจฉริยะ",
  description:
    "รับ event จากกล้อง/NVR เดิมของลูกค้า กรองด้วย AI แจ้งเตือน LINE สรุปรายงานอัตโนมัติ",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="th">
      <body className={anuphan.className} style={{ margin: 0, color: "#1D1D1F" }}>
        {children}
      </body>
    </html>
  );
}
