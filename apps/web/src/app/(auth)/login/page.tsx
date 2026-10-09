import type { Metadata } from "next";

import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Entrar" };

const ERRORS: Record<string, string> = {
  config: "Supabase não configurado. Defina NEXT_PUBLIC_SUPABASE_URL e NEXT_PUBLIC_SUPABASE_ANON_KEY.",
  inactive: "Seu usuário está inativo. Procure um administrador.",
  auth: "Link de autenticação inválido ou expirado.",
  link: "Este link do e-mail já foi usado ou venceu (vale 24 horas). Peça ao administrador um novo convite ou clique em “Esqueci minha senha”.",
  suspended: "O acesso do seu escritório está suspenso. Entre em contato com o suporte.",
  "no-org": "Seu usuário ainda não está vinculado a um escritório. Peça um novo convite ao administrador.",
};

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;
  const error = typeof params.error === "string" ? ERRORS[params.error] : undefined;
  const next = typeof params.next === "string" && params.next.startsWith("/") ? params.next : "/dashboard";
  return <LoginForm initialError={error} next={next} />;
}
