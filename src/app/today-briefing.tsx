"use client";

import { useEffect, useState } from "react";
import { buildTodayBriefing, nextLocalMidnight, type DailyWeather } from "@/lib/today-briefing";

export default function TodayBriefing({ daily, timezone }: { daily?: DailyWeather[]; timezone: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const update = () => {
      clearTimeout(timer);
      const current = Date.now();
      setNow(current);
      timer = setTimeout(update, nextLocalMidnight(current, timezone) - current);
    };
    update();
    const onVisible = () => { if (document.visibilityState === "visible") update(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [timezone]);
  const text = buildTodayBriefing(daily, timezone, now);
  if (!text) return null;
  return <section className="today-briefing" aria-labelledby="today-title"><h2 id="today-title" className="eyebrow">TODAY</h2><p>{text}</p></section>;
}
