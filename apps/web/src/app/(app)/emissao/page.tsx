import { Lock } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { HelpTip } from "@/components/list-extras";
import { EmitBoard } from "@/components/nfse/emit-board";
import { EmitOffices, type EmitOffice } from "@/components/nfse/emit-offices";
import { PageHeader } from "@/components/page-header";
import { requireSession } from "@/lib/auth";
import { currentCompetence } from "@/lib/competence";
import { emitAccess, EMISSION_COLUMNS, NFSE_EMIT_RELEASED, type Emission, type EmitActivity } from "@/lib/nfse-emit";
import { can } from "@/lib/permissions";
import { loadPlannerClients } from "@/lib/queries";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Emitir NFS-e" };

export default async function EmissaoPage({ searchParams }: PageProps<"/emissao">) {
  const { profile } = await requireSession();
  const { ver } = await searchParams;
  const supabase = await createClient();
  const enabledRes = await supabase.rpc("nfse_emit_enabled");
  const enabled = enabledRes.data === true;
  const access = emitAccess({ released: NFSE_EMIT_RELEASED, officeEnabled: enabled, isOwner: profile.is_platform_owner });

  // o dono da plataforma pode abrir a tela como os escritórios a veem (?ver=escritorio)
  const preview = access === "testing" && ver === "escritorio";

  // função travada para quem está vendo: só o aviso, sem carregar nada da emissão
  if (access === "locked" || preview) {
    return (
      <>
        <PageHeader title="Emitir NFS-e" description="Emita a nota de serviço do cliente sem entrar no site da prefeitura." />
        <section className="flex flex-col items-center gap-3 rounded-xl border bg-card px-6 py-12 text-center shadow-card">
          <span className="grid size-12 place-items-center rounded-full bg-(--c-f5f5f2) text-(--c-6b6c66)">
            <Lock className="size-5" />
          </span>
          <h2 className="text-[16px] font-semibold">{NFSE_EMIT_RELEASED ? "Função não ligada para este escritório" : "Em breve"}</h2>
          <p className="max-w-xl text-[13.5px] text-muted-foreground">
            {NFSE_EMIT_RELEASED
              ? "A emissão de NFS-e é uma função à parte do JR Sistema. Fale com o suporte para ligar a emissão no seu escritório."
              : "A emissão de NFS-e pelo JR Sistema está em preparação. Quando for liberada, você vai emitir a nota de serviço do cliente por aqui, sem entrar no site da prefeitura."}
          </p>
        </section>
        {preview ? (
          <p className="mt-3 text-center text-[13px] text-muted-foreground">
            É assim que os escritórios veem esta aba.{" "}
            <Link href="/emissao" className="text-primary hover:underline">
              Voltar para a tela de teste
            </Link>
          </p>
        ) : null}
      </>
    );
  }

  const [clients, eligibleRes, emissionsRes, profilesRes, officesRes, activitiesRes] = await Promise.all([
    loadPlannerClients(),
    supabase.rpc("nfse_emit_clients"),
    supabase.from("nfse_emissions").select(EMISSION_COLUMNS).order("created_at", { ascending: false }).limit(300),
    supabase.from("profiles").select("user_id, name"),
    profile.is_platform_owner ? supabase.from("organizations").select("id, name, nfse_emit_enabled").order("name") : Promise.resolve({ data: [] }),
    supabase.rpc("nfse_emit_activities"),
  ]);
  const eligible = new Map(((eligibleRes.data ?? []) as { client_id: string; notas: number }[]).map((r) => [r.client_id, Number(r.notas)]));
  const offices = (officesRes.data ?? []) as EmitOffice[];
  const active = clients.filter((c) => c.active);

  return (
    <>
      <PageHeader
        title="Emitir NFS-e"
        description="Emita a nota de serviço do cliente sem entrar no site da prefeitura. O robô assina com o certificado da própria empresa."
        help={
          <HelpTip>
            <p>
              A nota nova é montada a partir de uma <b>nota real que a empresa já emitiu</b>: o código do serviço, a alíquota
              e a retenção de ISS são copiados dela. Você escolhe o tomador, a descrição e o valor, confere a prévia e
              confirma. Nada sai sem a sua confirmação.
            </p>
            <p>
              Quem envia é o robô do escritório, com o certificado da empresa. Por enquanto, só para empresas de{" "}
              <b>Teresina</b> no <b>Simples Nacional</b>, e para serviços sem retenção de imposto federal. A numeração é
              própria (série 10001) e não se mistura com a das notas emitidas no site da prefeitura.
            </p>
          </HelpTip>
        }
      />

      {access === "testing" ? (
        <div className="mb-3 flex items-start gap-2 rounded-[9px] border border-(--c-f3dfb4) bg-(--c-fdf4e3) px-3 py-2 text-[12.5px] text-(--c-9a6205)">
          <Lock className="mt-0.5 size-3.5 shrink-0" />
          <p>
            <b>Função travada, em teste.</b> Para os escritórios, esta aba aparece no menu com cadeado e abre só o aviso “Em breve”. Só você, dono da
            plataforma, entra aqui.{" "}
            <Link href="/emissao?ver=escritorio" className="font-medium underline underline-offset-2">
              Ver como os escritórios veem
            </Link>
          </p>
        </div>
      ) : null}

      {enabled ? (
        <EmitBoard
          canRun={can(profile.role, "automation:run")}
          isOwner={profile.is_platform_owner}
          aiReady={Boolean(process.env.ANTHROPIC_API_KEY)}
          month={currentCompetence()}
          activities={((activitiesRes.data ?? []) as EmitActivity[]).map((a) => ({ ...a, notas: Number(a.notas) }))}
          userNames={Object.fromEntries(((profilesRes.data ?? []) as { user_id: string; name: string }[]).map((p) => [p.user_id, p.name]))}
          initialEmissions={(emissionsRes.data ?? []) as unknown as Emission[]}
          clients={active
            .filter((c) => eligible.has(c.id))
            .map((c) => ({
              id: c.id,
              client_code: c.client_code,
              name: c.trade_name || c.legal_name,
              cnpj: c.cnpj,
              certificate_ok: c.certificate_status === "valid" || c.certificate_status === "expiring",
              notas: eligible.get(c.id) ?? 0,
            }))
            .sort((a, b) => a.name.localeCompare(b.name, "pt-BR", { sensitivity: "base" }))}
        />
      ) : (
        <section className="rounded-xl border bg-card p-6 shadow-card">
          <h2 className="text-[15px] font-semibold">A emissão de NFS-e ainda não está ligada para este escritório</h2>
          <p className="mt-1 max-w-2xl text-[13.5px] text-muted-foreground">
            {profile.is_platform_owner
              ? "Ligue no quadro abaixo os escritórios que vão emitir notas pelo sistema."
              : "É uma função à parte do JR Sistema. Fale com o suporte para ligar a emissão no seu escritório."}
          </p>
        </section>
      )}

      {enabled && eligible.size === 0 ? (
        <p className="mt-3 text-[13px] text-muted-foreground">
          Nenhuma empresa tem ainda uma nota que sirva de modelo. Busque as notas em{" "}
          <Link href="/nfse" className="text-primary hover:underline">
            NFS-e Nacional
          </Link>{" "}
          e aguarde o robô ler o histórico.
        </p>
      ) : null}

      {profile.is_platform_owner && offices.length ? (
        <div className="mt-4">
          <EmitOffices offices={offices} />
        </div>
      ) : null}
    </>
  );
}
