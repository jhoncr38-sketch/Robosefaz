"use client";

import { useEffect, useState } from "react";

/**
 * Relógio para cronômetros, contagens regressivas e "há 2h". Fica `null` até montar no
 * navegador (servidor e navegador têm relógio e fuso diferentes) e depois avança a cada `intervalMs`.
 */
export function useNow(intervalMs = 1000): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const first = setTimeout(() => setNow(Date.now()), 0);
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [intervalMs]);
  return now;
}
