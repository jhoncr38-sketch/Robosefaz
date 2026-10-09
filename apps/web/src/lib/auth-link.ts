// Links dos e-mails de login (convite, redefinir senha) que voltam ao painel com a sessão
// no fim do endereço: https://jrsistema.com/#access_token=...&refresh_token=...&type=invite
// (ou #error_code=otp_expired quando o link já foi usado ou venceu).

export type AuthLink =
  | { kind: "session"; accessToken: string; refreshToken: string; type: string }
  | { kind: "error"; code: string }
  | null;

export function parseAuthHash(hash: string): AuthLink {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const code = params.get("error_code") ?? params.get("error");
  if (code) return { kind: "error", code };
  const accessToken = params.get("access_token");
  const refreshToken = params.get("refresh_token");
  if (accessToken && refreshToken) return { kind: "session", accessToken, refreshToken, type: params.get("type") ?? "" };
  return null;
}

/** Tela de criar a senha do primeiro acesso (para onde o convite leva). */
export const INVITE_PATH = "/reset-password?primeiro=1";

/** Para onde ir depois de entrar pelo link: convite -> criar a senha; redefinição -> nova senha. */
export function authLinkTarget(type: string, next = "/dashboard"): string {
  if (type === "invite" || type === "signup") return INVITE_PATH;
  if (type === "recovery") return "/reset-password";
  return next.startsWith("/") ? next : "/dashboard";
}

const PASSWORD_ERRORS: Record<string, string> = {
  "Auth session missing!": "O link do e-mail já foi usado ou venceu. Peça um novo convite ou clique em “Esqueci minha senha”.",
  "New password should be different from the old password.": "A nova senha precisa ser diferente da anterior.",
};

/** Mensagem em português para o erro ao gravar a senha. */
export function passwordErrorMessage(message: string): string {
  return PASSWORD_ERRORS[message] ?? message;
}
