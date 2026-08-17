"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

// A monitoring page must not depend on someone pressing F5. Soft-refresh the
// server data on an interval; pause while the tab is hidden to save quota.
export function AutoRefresh({ seconds = 30 }: { seconds?: number }) {
  const router = useRouter();
  const [tick, setTick] = useState(seconds);

  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      setTick((t) => {
        if (t <= 1) {
          router.refresh();
          return seconds;
        }
        return t - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [router, seconds]);

  return (
    <span style={{ fontSize: "0.8rem", color: "#9E9E9E" }} title="หน้านี้อัปเดตอัตโนมัติ">
      🔄 อัปเดตใน {tick} วิ
    </span>
  );
}
