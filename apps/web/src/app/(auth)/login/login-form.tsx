"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowRight, Eye, EyeOff, Loader2, Lock, Mail } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { whatsappLink } from "@/lib/contact";
import { createClient } from "@/lib/supabase/client";

const schema = z.object({
  email: z.email("Informe um e-mail válido"),
  password: z.string().min(1, "Informe a senha"),
});

type FormValues = z.infer<typeof schema>;

export function LoginForm({ initialError, next }: { initialError?: string; next: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | undefined>(initialError);
  const [showPassword, setShowPassword] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  async function onSubmit(values: FormValues) {
    setError(undefined);
    const supabase = createClient();
    const { error: authError } = await supabase.auth.signInWithPassword(values);
    if (authError) {
      setError(authError.message === "Invalid login credentials" ? "E-mail ou senha incorretos." : authError.message);
      return;
    }
    router.replace(next);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-[28px] leading-tight font-semibold tracking-[-0.02em] text-(--c-13294b)">Bem-vindo de volta</h1>
        <p className="text-sm text-muted-foreground">Entre para acompanhar automações, certificados e downloads.</p>
      </div>
      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <div className="space-y-1.5">
          <Label htmlFor="email">E-mail</Label>
          <div className="relative">
            <Mail className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-(--c-9a9b94)" />
            <Input
              id="email"
              type="email"
              autoComplete="email"
              autoFocus
              placeholder="seu@email.com"
              className="h-11 pl-9"
              {...register("email")}
              aria-invalid={!!errors.email}
            />
          </div>
          {errors.email ? <p className="text-xs text-destructive">{errors.email.message}</p> : null}
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="password">Senha</Label>
            <Link href="/forgot-password" className="text-xs font-medium text-primary hover:underline">
              Esqueci minha senha
            </Link>
          </div>
          <div className="relative">
            <Lock className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-(--c-9a9b94)" />
            <Input
              id="password"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              placeholder="Digite sua senha"
              className="h-11 pr-10 pl-9"
              {...register("password")}
              aria-invalid={!!errors.password}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? "Esconder senha" : "Mostrar senha"}
              className="absolute top-1/2 right-2 grid size-7 -translate-y-1/2 place-items-center rounded-md text-(--c-9a9b94) hover:text-foreground"
            >
              {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
          {errors.password ? <p className="text-xs text-destructive">{errors.password.message}</p> : null}
        </div>
        <Button
          type="submit"
          className="mt-2 h-11 w-full gap-2 bg-gradient-to-r from-(--c-1f7a4d) to-(--c-1fa37a) text-[15px] hover:from-(--c-196640) hover:to-(--c-1b8f6a)"
          disabled={isSubmitting}
        >
          {isSubmitting ? <Loader2 className="animate-spin" /> : null}
          Entrar
          {!isSubmitting ? <ArrowRight className="size-4" /> : null}
        </Button>
      </form>
      <p className="text-center text-xs text-(--c-9a9b94)">
        Ainda não é cliente?{" "}
        {whatsappLink() ? (
          <a
            href={whatsappLink() ?? undefined}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-primary hover:underline"
          >
            Fale com a nossa equipe
          </a>
        ) : (
          <span className="font-medium">Fale com a nossa equipe</span>
        )}{" "}
        e conheça o JR Sistema.
      </p>
    </div>
  );
}
