// Contato comercial do JR Sistema (link "Fale com a nossa equipe" na tela de login).
// Número com DDI e DDD, só dígitos (ex.: "5586999999999"). Vazio = o link não aparece.
export const CONTACT_WHATSAPP = "5586994502488";

export const CONTACT_MESSAGE = "Olá! Quero conhecer o JR Sistema.";

export function whatsappLink(): string | null {
  const digits = CONTACT_WHATSAPP.replace(/\D/g, "");
  if (!digits) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(CONTACT_MESSAGE)}`;
}
