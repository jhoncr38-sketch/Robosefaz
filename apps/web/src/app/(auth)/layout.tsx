import { ShieldCheck } from "lucide-react";
import Image from "next/image";

import { ForceLight } from "@/components/theme/theme";

// Login: só a logo e o formulário, no centro da tela (sem painel de apresentação).
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-white px-6 py-10 sm:px-12">
      <ForceLight />
      <div className="mx-auto flex w-full max-w-[400px] flex-1 flex-col items-center justify-center gap-8">
        <Image src="/brand/logo-full.png" alt="JR Sistema" width={260} height={86} priority className="h-auto w-[260px]" />
        <div className="w-full">{children}</div>
      </div>
      <p className="mt-8 flex items-center justify-center gap-1.5 text-xs text-(--c-9a9b94)">
        <ShieldCheck className="size-3.5" /> Acesso seguro e protegido
        <span aria-hidden>·</span> JR Sistema © {new Date().getFullYear()}
      </p>
    </div>
  );
}
