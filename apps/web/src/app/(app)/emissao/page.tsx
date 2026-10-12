import { FlaskConical, Lock } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { HelpTip } from "@/components/list-extras";
import { EmitBoard } from "@/components/nfse/emit-board";
import { EmitOffices, type EmitOffice } from "@/components/nfse/emit-offices";
import { PageHeader } from "@/components/page-header";
import { requireSession } from "@/lib/auth";
import { currentCompetence } from "@/lib/competence";
import { emitAccess, EMISSION_COLUMNS, NFSE_EMIT_RELEASED, type Emission, type EmitActivity } from "@/lib/nfse-emit";
import { DEMO_CLIENT, DEMO_NOTES } from "@/lib/nfse-emit-demo";
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

  // função travada para quem está vendo: o aviso de bloqueado e uma amostra da tela, com dados de exemplo.
  // Nada da emissão é carregado, a amostra não deixa clicar e as ações continuam recusando no servidor
  if (access === "locked" || preview) {
    return (
      <>
        <PageHeader title="Emitir NFS-e" description="Emita a nota de serviço do cliente sem entrar no site da prefeitura." />
        <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border border-(--c-f0d9a8) bg-(--c-fdf4e3) py-3.5 pr-3.5 pl-4 shadow-[0_1px_2px_rgba(154,98,5,0.08)]">
          <span className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-(--c-e0a019) text-white shadow-[0_2px_6px_rgba(224,160,25,0.35)]">
            <Lock className="size-[19px]" />
          </span>
          <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <b className="text-[14.5px] font-semibold text-(--c-6b4204)">Bloqueado</b>
              <span className="inline-flex items-center rounded-full border border-(--c-f0d9a8) bg-card px-2 py-px text-[11.5px] font-medium whitespace-nowrap text-(--c-8a5a06)">
                {NFSE_EMIT_RELEASED ? "Não ligado para este escritório" : "Em breve"}
              </span>
            </div>
            <p className="text-[13px] leading-[1.45] text-(--c-7a5410)">
              {NFSE_EMIT_RELEASED
                ? "A emissão de NFS-e é uma função à parte do JR Sistema. Fale com o suporte para ligar no seu escritório. "
                : "Novidade a caminho: em breve você vai emitir a nota de serviço do cliente por aqui, sem entrar no site da prefeitura. "}
              A tela abaixo é uma amostra, com dados de exemplo.
            </p>
          </div>
        </div>
        <div className="relative select-none" title="Bloqueado: esta tela é uma amostra">
          <EmitBoard canRun isOwner={false} aiReady month={currentCompetence()} activities={[]} userNames={{}} initialEmissions={[]} clients={[DEMO_CLIENT]} demoNotes={DEMO_NOTES} />
          {/* por cima da amostra: nada embaixo recebe clique */}
          <div aria-hidden className="absolute inset-0 cursor-not-allowed" />
        </div>
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
            <p>
              Em <b>outra atividade</b>, o código complementar é o do cadastro da empresa na prefeitura: aqui aparecem os que
              já saíram em nota. Se o código não constar no cadastro, a prefeitura recusa a nota e nada é emitido. As listas
              de NBS, classificação tributária e indicador da operação vêm das tabelas oficiais da NFS-e nacional.
            </p>
          </HelpTip>
        }
      />

      {access === "testing" ? (
        <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border border-(--c-f0d9a8) bg-(--c-fdf4e3) py-3.5 pr-3.5 pl-4 shadow-[0_1px_2px_rgba(154,98,5,0.08)]">
          <span className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-(--c-e0a019) text-white shadow-[0_2px_6px_rgba(224,160,25,0.35)]">
            <FlaskConical className="size-[19px]" />
          </span>
          <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <b className="text-[14.5px] font-semibold text-(--c-6b4204)">Modo de teste</b>
              {/* bg-card e text-card em vez de branco fixo: no modo noturno o fundo e o texto invertem juntos */}
              <span className="inline-flex items-center gap-1 rounded-full border border-(--c-f0d9a8) bg-card px-2 py-px text-[11.5px] font-medium whitespace-nowrap text-(--c-8a5a06)">
                <Lock className="size-[11px]" /> Só você vê esta tela
              </span>
            </div>
            <p className="text-[13px] leading-[1.45] text-(--c-7a5410)">Para os escritórios, a aba aparece com cadeado e mostra uma amostra bloqueada da tela.</p>
          </div>
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
            // com certificado válido primeiro (são as que emitem); dentro de cada grupo, por nome
            .sort((a, b) => Number(b.certificate_ok) - Number(a.certificate_ok) || a.name.localeCompare(b.name, "pt-BR", { sensitivity: "base" }))}
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
