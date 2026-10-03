// Sem "use client": o layout raiz (servidor) injeta este script no <head>.

export const THEME_KEY = "jr-theme";
/** Estilo do menu lateral: "branco" (padrão) ou "escuro". */
export const MENU_STYLE_KEY = "jr-menu-estilo";
export type MenuStyle = "branco" | "escuro";

/** Roda antes da pintura (no <head>): evita a tela piscar clara no modo escuro (e o menu piscar branco). */
export const THEME_BOOT_SCRIPT = `(function(){try{var p=location.pathname;if(/^\\/(login|forgot-password|reset-password|auth)(\\/|$)/.test(p))return;var v=localStorage.getItem("${THEME_KEY}");var d=v==="dark"||(v==="system"&&matchMedia("(prefers-color-scheme: dark)").matches);if(d){document.documentElement.classList.add("dark");document.documentElement.style.colorScheme="dark";}if(localStorage.getItem("${MENU_STYLE_KEY}")==="escuro"){document.documentElement.dataset.menu="escuro";}}catch(e){}})();`;
