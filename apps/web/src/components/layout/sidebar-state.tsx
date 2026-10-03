"use client";

// Menu lateral recolhível (Ctrl+B) e estilo do menu (claro ou escuro), escolhas de cada usuário.
// Recolhido fica no cookie "jr-nav" (lido no servidor: o menu não pisca ao carregar);
// o estilo fica no navegador e é aplicado antes da pintura (lib/theme-boot.ts).

import { createContext, useCallback, useContext, useEffect, useState, type CSSProperties } from "react";

import {
  NAV_COLLAPSED_KEY,
  NAV_STATE_COOKIE,
  parseFolderState,
  serializeFolderState,
} from "@/components/layout/nav-items";
import { MENU_STYLE_KEY, type MenuStyle } from "@/lib/theme-boot";

/** Guarda uma escolha do menu (pasta aberta/fechada, menu recolhido) no cookie "jr-nav". */
export function saveNavChoice(key: string, value: boolean): void {
  const hit = document.cookie.split("; ").find((c) => c.startsWith(`${NAV_STATE_COOKIE}=`));
  const state = parseFolderState(hit ? decodeURIComponent(hit.slice(NAV_STATE_COOKIE.length + 1)) : "");
  state[key] = value;
  document.cookie = `${NAV_STATE_COOKIE}=${encodeURIComponent(serializeFolderState(state))}; path=/; max-age=31536000; samesite=lax`;
}

const SidebarContext = createContext<{ collapsed: boolean; toggle: () => void }>({
  collapsed: false,
  toggle: () => {},
});

export function useSidebar() {
  return useContext(SidebarContext);
}

/** Envolve o painel: a largura do menu vira a variável --sb-w (menu e conteúdo acompanham). */
export function SidebarFrame({ initialCollapsed, children }: { initialCollapsed: boolean; children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);

  const toggle = useCallback(() => {
    setCollapsed((c) => !c);
  }, []);

  // grava depois de mudar (o updater do setState pode rodar duas vezes no modo de desenvolvimento)
  useEffect(() => {
    saveNavChoice(NAV_COLLAPSED_KEY, collapsed);
  }, [collapsed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "b") return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  return (
    <SidebarContext.Provider value={{ collapsed, toggle }}>
      <div className="min-h-screen bg-background" style={{ "--sb-w": collapsed ? "64px" : "232px" } as CSSProperties}>
        {children}
      </div>
    </SidebarContext.Provider>
  );
}

export const MENU_STYLE_EVENT = "jr-menu-style-change";

export function readMenuStyle(): MenuStyle {
  try {
    return window.localStorage.getItem(MENU_STYLE_KEY) === "escuro" ? "escuro" : "branco";
  } catch {
    return "branco";
  }
}

export function applyMenuStyle(style: MenuStyle): void {
  if (style === "escuro") document.documentElement.dataset.menu = "escuro";
  else delete document.documentElement.dataset.menu;
}

export function saveMenuStyle(style: MenuStyle): void {
  try {
    window.localStorage.setItem(MENU_STYLE_KEY, style);
  } catch {
    // navegador sem armazenamento: vale só nesta aba
  }
  applyMenuStyle(style);
  window.dispatchEvent(new Event(MENU_STYLE_EVENT));
}

/** Estilo atual do menu, atualizado quando muda no menu do usuário ou em outra aba. */
export function useMenuStyle(): MenuStyle {
  const [style, setStyle] = useState<MenuStyle>("branco");
  useEffect(() => {
    const sync = () => {
      const s = readMenuStyle();
      applyMenuStyle(s);
      setStyle(s);
    };
    const first = setTimeout(sync, 0);
    window.addEventListener(MENU_STYLE_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      clearTimeout(first);
      window.removeEventListener(MENU_STYLE_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return style;
}
