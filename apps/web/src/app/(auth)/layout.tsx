import { FileArchive } from "lucide-react";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-emerald-50/60 to-background px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center justify-center gap-2.5">
          <div className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <FileArchive className="size-5" />
          </div>
          <div>
            <p className="text-sm font-semibold leading-tight">SIAT Automação</p>
            <p className="text-xs text-muted-foreground leading-tight">SEFAZ-PI · Documentos fiscais</p>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}
