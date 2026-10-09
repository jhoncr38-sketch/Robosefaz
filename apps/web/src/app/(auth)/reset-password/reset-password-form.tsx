"use client";

import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { passwordErrorMessage } from "@/lib/auth-link";
import { createClient } from "@/lib/supabase/client";

/** Nova senha: no primeiro acesso (convite) e no "Esqueci minha senha". */
export function ResetPasswordForm({ firstAccess }: { firstAccess: boolean }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  // undefined = conferindo; null = sem sessão (link não usado, vencido ou já usado)
  const [email, setEmail] = useState<string | null>();

  useEffect(() => {
    const { data } = createClient().auth.onAuthStateChange((_event, session) => setEmail(session?.user.email ?? null));
    return () => data.subscription.unsubscribe();
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    if (password.length < 10) {
      setError("A senha deve ter no mínimo 10 caracteres.");
      return;
    }
    if (password !== confirm) {
      setError("As senhas não conferem.");
      return;
    }
    setLoading(true);
    const supabase = createClient();
    const { error: err } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (err) {
      setError(passwordErrorMessage(err.message));
      return;
    }
    toast.success(firstAccess ? "Senha criada. Bem-vindo ao JR Sistema!" : "Senha alterada com sucesso.");
    router.replace("/dashboard");
    router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{firstAccess ? "Crie sua senha" : "Definir nova senha"}</CardTitle>
        <CardDescription>
          {firstAccess
            ? "Bem-vindo ao JR Sistema! Para o seu primeiro acesso, escolha uma senha com pelo menos 10 caracteres."
            : "Escolha uma senha forte com pelo menos 10 caracteres."}
        </CardDescription>
        {email ? (
          <p className="pt-1 text-xs text-muted-foreground">
            Conta: <span className="font-medium text-foreground">{email}</span>
          </p>
        ) : null}
      </CardHeader>
      <CardContent>
        {email === null ? (
          <Alert className="mb-4">
            <AlertDescription>
              Abra esta tela pelo link do e-mail. Se o link já foi usado ou venceu (vale 24 horas), peça um novo convite ao
              administrador ou use{" "}
              <Link href="/forgot-password" className="font-medium text-primary hover:underline">
                Esqueci minha senha
              </Link>
              .
            </AlertDescription>
          </Alert>
        ) : null}
        <form onSubmit={onSubmit} className="space-y-4">
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor="password">{firstAccess ? "Senha" : "Nova senha"}</Label>
            <Input id="password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="confirm">Confirmar senha</Label>
            <Input id="confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </div>
          <Button type="submit" className="w-full" disabled={loading || email === null}>
            {loading ? <Loader2 className="animate-spin" /> : null}
            {firstAccess ? "Criar senha e entrar" : "Salvar senha"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
