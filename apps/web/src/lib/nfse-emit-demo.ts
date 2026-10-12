// Amostra da tela Emitir NFS-e para quem ainda não tem a função: empresa, tomadores e notas inventados.
// Nenhum dado daqui vem do banco, e nada do que a amostra mostra pode ser enviado.
import type { EmitClient } from "@/components/nfse/emit-board";
import type { EmitNote } from "@/lib/nfse-emit";

export const DEMO_CLIENT: EmitClient = {
  id: "amostra",
  client_code: "CLI000000",
  name: "EMPRESA EXEMPLO LTDA",
  cnpj: "11222333000181",
  certificate_ok: true,
  notas: 9,
};

const note = (numero: number, dia: string, valor: number, tomador: [string, string], descricao: string): EmitNote => ({
  // município (7) + ambiente (1) + tipo de inscrição (1) + CNPJ (14) + número (13) + ano e mês (4) + código (9) + dígito (1)
  chave: `22110011211222333000181${String(numero).padStart(13, "0")}26090000000010`,
  numero,
  emitida_em: `2026-09-${dia}T10:00:00-03:00`,
  valor,
  dest_doc: tomador[0],
  dest_nome: tomador[1],
  servico: descricao,
  c_trib_nac: "140101",
  c_trib_mun: "001",
  servico_nome: "MANUTENÇÃO DE AR-CONDICIONADO",
  emit_model: "ok",
  canceled: false,
});

export const DEMO_NOTES: EmitNote[] = [
  note(128, "24", 1500, ["22222222000191", "CONDOMINIO SOL"], "Manutenção preventiva do ar do salão de festas"),
  note(127, "15", 980, ["33333333000191", "CLINICA EXEMPLO"], "Limpeza e revisão de três aparelhos"),
  note(126, "03", 1500, ["22222222000191", "CONDOMINIO SOL"], "Manutenção preventiva do ar do salão de festas"),
];
