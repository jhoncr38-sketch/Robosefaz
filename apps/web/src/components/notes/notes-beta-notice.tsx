"use client";

import { Bot, FlaskConical, KeyRound, ShieldCheck, TriangleAlert } from "lucide-react";
import { useState, useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

function Item({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-(--c-e6f4ec) text-primary">{icon}</span>
      <div className="min-w-0 text-[13px]">
        <p className="font-medium">{title}</p>
        <p className="text-(--c-6b6c66)">{children}</p>
      </div>
    </li>
  );
}

// "Não mostrar de novo" fica só neste navegador (conveniência da pessoa, não é dado do sistema)
const STORAGE_KEY = "jr:busca-chave:aviso-beta-dispensado";

function readDismissed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Aviso de fase beta da busca por chave de acesso: aparece toda vez que a tela é aberta pelo menu
 * (sem chave na busca), até a pessoa marcar "Não mostrar de novo" neste navegador.
 */
export function NotesBetaNotice() {
  // no servidor conta como dispensado (nada é desenhado); no navegador vale o que está guardado
  const dismissed = useSyncExternalStore(
    () => () => {},
    readDismissed,
    () => true,
  );
  const [closed, setClosed] = useState(false);
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const open = !dismissed && !closed;

  function close() {
    if (dontShowAgain) {
      try {
        localStorage.setItem(STORAGE_KEY, "1");
      } catch {
        // navegador sem armazenamento: o aviso volta na próxima vez
      }
    }
    setClosed(true);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? setClosed(false) : close())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-(--c-fdf4e3) px-2 py-0.5 text-[11px] font-semibold tracking-[0.04em] text-(--c-9a6205) uppercase">
              Beta
            </span>
            <span className="text-xs text-(--c-6b6c66)">função nova, em fase de testes</span>
          </div>
          <DialogTitle className="flex items-center gap-2">
            <FlaskConical className="size-4 text-primary" /> Busca por chave de acesso
          </DialogTitle>
          <DialogDescription>
            Esta tela está em fase beta. Ela já funciona, mas ainda está sendo acompanhada de perto; se algo sair
            diferente do esperado, avise o suporte com a chave usada.
          </DialogDescription>
        </DialogHeader>

        <ul className="flex flex-col gap-3">
          <Item icon={<KeyRound className="size-3.5" />} title="Cole a chave de acesso completa">
            São os 44 números da DANFE. Se a nota já foi baixada pelo robô, ela abre na hora, montada no formato da
            DANFE, com a opção de baixar o XML.
          </Item>
          <Item icon={<Bot className="size-3.5" />} title="Nota que ainda não foi baixada">
            Você escolhe a empresa e o robô entra no SIAT com o certificado dela para exportar só essa nota. Leva cerca
            de 1 minuto e precisa de um computador do escritório com o robô ligado. Vale só para NF-e (modelo 55).
          </Item>
          <Item icon={<ShieldCheck className="size-3.5" />} title="Escolha a empresa certa">
            O SIAT só entrega a nota ao emitente ou ao destinatário. Se o emitente for cliente do escritório, ele já
            vem selecionado; se for uma compra, escolha quem recebeu. Com a empresa errada o SIAT não devolve nada.
          </Item>
          <Item icon={<TriangleAlert className="size-3.5" />} title="Visualização para conferência">
            A tela da nota é montada a partir do XML e serve para conferir. O documento fiscal continua sendo o XML; a
            DANFE oficial é a emitida pelo contribuinte. O arquivo baixado fica na pasta da empresa, em “Avulsas”.
          </Item>
        </ul>

        <DialogFooter className="items-center gap-3 sm:justify-between">
          <label className="flex cursor-pointer items-center gap-2 text-[13px] text-(--c-6b6c66) select-none">
            <Checkbox checked={dontShowAgain} onCheckedChange={(v) => setDontShowAgain(v === true)} />
            Não mostrar de novo neste computador
          </label>
          <Button onClick={close}>Entendi</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
