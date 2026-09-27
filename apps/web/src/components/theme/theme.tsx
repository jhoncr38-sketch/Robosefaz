"use client";

// Tema do painel (claro, escuro ou igual ao Windows). A escolha fica no navegador
// (localStorage); o padrão é claro. A tela de login é sempre clara (a logo tem
// "SISTEMA" em azul-marinho, que sumiria no fundo escuro).

import { useEffect, useState } from "react";

import { THEME_KEY } from "@/lib/theme-boot";

export type ThemeChoice = "light" | "dark" | "system";

export { THEME_KEY };
export const THEME_EVENT = "jr-theme-change";

export function readTheme(): ThemeChoice {
  try {
    const v = window.localStorage.getItem(THEME_KEY);
    return v === "dark" || v === "system" ? v : "light";
  } catch {
    return "light";
  }
}

function resolve(choice: ThemeChoice): "light" | "dark" {
  if (choice === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return choice;
}

export function applyTheme(choice: ThemeChoice): void {
  const dark = resolve(choice) === "dark";
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

export function saveTheme(choice: ThemeChoice): void {
  try {
    window.localStorage.setItem(THEME_KEY, choice);
  } catch {
    // navegador sem armazenamento: vale só nesta aba
  }
  applyTheme(choice);
  window.dispatchEvent(new Event(THEME_EVENT));
}

/** Escolha atual, atualizada quando muda em outro lugar (menu, outra aba). */
export function useThemeChoice(): ThemeChoice {
  const [choice, setChoice] = useState<ThemeChoice>("light");
  useEffect(() => {
    const sync = () => setChoice(readTheme());
    const first = setTimeout(sync, 0);
    window.addEventListener(THEME_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      clearTimeout(first);
      window.removeEventListener(THEME_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return choice;
}

/** Aplica o tema nas telas do painel e acompanha o Windows no modo automático. */
export function ThemeSync() {
  useEffect(() => {
    applyTheme(readTheme());
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme(readTheme());
    media.addEventListener("change", onChange);
    window.addEventListener("storage", onChange);
    return () => {
      media.removeEventListener("change", onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);
  return null;
}

/** Login e recuperação de senha: sempre claros. */
export function ForceLight() {
  useEffect(() => {
    document.documentElement.classList.remove("dark");
    document.documentElement.style.colorScheme = "light";
  }, []);
  return null;
}
