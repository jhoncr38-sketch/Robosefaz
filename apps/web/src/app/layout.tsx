import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "sonner";

import { TooltipProvider } from "@/components/ui/tooltip";
import { THEME_BOOT_SCRIPT } from "@/lib/theme-boot";

import "./globals.css";

const geistSans = Geist({ variable: "--font-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "JR Sistema", template: "%s · JR Sistema" },
  description: "JR Sistema: automação do SIAT Web (SEFAZ-PI), agendamento e download de NFC-e e NF-e.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // o tema escuro é aplicado antes da hidratação (classe "dark" no <html>)
    <html lang="pt-BR" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      {/* extensões do navegador (ex.: ColorZilla) injetam atributos no <body> */}
      <body className="min-h-full" suppressHydrationWarning>
        <TooltipProvider delayDuration={200}>{children}</TooltipProvider>
        <Toaster richColors position="top-right" closeButton />
      </body>
    </html>
  );
}
