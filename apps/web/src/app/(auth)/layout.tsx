import { ShieldCheck } from "lucide-react";
import Image from "next/image";

import { ForceLight } from "@/components/theme/theme";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen bg-white lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
      <ForceLight />
      {/* formulário */}
      <div className="flex flex-col px-6 py-10 sm:px-12">
        <div className="mx-auto flex w-full max-w-[380px] flex-1 flex-col justify-center gap-8">
          <Image src="/brand/logo-full.png" alt="JR Sistema" width={250} height={83} priority className="h-auto w-[250px]" />
          {children}
        </div>
        <p className="mt-8 flex items-center justify-center gap-1.5 text-xs text-(--c-9a9b94)">
          <ShieldCheck className="size-3.5" /> Acesso seguro e protegido
        </p>
      </div>

      {/* apresentação (só em telas grandes) */}
      <div className="relative hidden overflow-hidden border-l border-(--c-e3efe7) bg-(--c-f3faf6) lg:flex">
        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(800px 480px at 90% 0%, rgba(63,224,160,.22), transparent 60%), radial-gradient(700px 480px at 0% 100%, rgba(31,122,77,.10), transparent 60%)",
          }}
        />
        <div className="relative m-auto flex w-full max-w-[760px] flex-col gap-8 px-12 py-10">
          <div className="flex flex-col gap-5 text-(--c-13294b)">
            <span className="flex w-fit items-center gap-2 rounded-full border border-(--c-cfe8d9) bg-white px-3 py-1 text-xs text-(--c-1c5e3c)">
              <span className="size-1.5 rounded-full bg-(--c-2ea062)" /> Automação SIAT · SEFAZ-PI
            </span>
            <h2 className="text-[34px] leading-[1.12] font-semibold tracking-[-0.02em]">
              Automação fiscal com mais controle, <span className="text-(--c-1f9a64)">agilidade e inteligência.</span>
            </h2>
            <p className="max-w-[560px] text-[15px] leading-relaxed text-(--c-4a5b55)">
              Agende exportações, acompanhe o robô em tempo real e encontre as notas de cada cliente em um só lugar.
            </p>
          </div>
          {/* print do painel (empresas fictícias) */}
          <div className="overflow-hidden rounded-xl border border-(--c-dfe9e3) bg-white shadow-[0_24px_60px_rgba(19,41,75,.14)]">
            <div className="flex h-8 items-center gap-1.5 border-b border-(--c-e8e8e4) bg-(--c-f3f3f0) px-3">
              <span className="size-2.5 rounded-full bg-(--c-ff5f57)" />
              <span className="size-2.5 rounded-full bg-(--c-febc2e)" />
              <span className="size-2.5 rounded-full bg-(--c-28c840)" />
              <span className="ml-3 rounded-md bg-white px-3 py-0.5 text-[11px] text-(--c-9a9b94)">jrsistema.com/dashboard</span>
            </div>
            <Image
              src="/brand/painel-dashboard-v2.jpg"
              alt="Dashboard do JR Sistema"
              width={1510}
              height={1075}
              className="block h-auto w-full"
              priority
            />
          </div>
        </div>
      </div>
    </div>
  );
}
