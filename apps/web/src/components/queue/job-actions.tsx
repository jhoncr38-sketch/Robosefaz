"use client";

import { Ban, Eye, Loader2, MoreHorizontal, PlayCircle, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";

import { cancelJob, confirmManualAction, retryJob } from "@/app/actions/automation";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { can } from "@/lib/permissions";
import { FINAL_JOB_STATUSES, MANUAL_JOB_STATUSES, RETRYABLE_JOB_STATUSES } from "@/lib/status";
import type { AutomationJob, UserRole } from "@/lib/types";

export function ContinueButton({ job, role }: { job: AutomationJob; role: UserRole }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  if (!MANUAL_JOB_STATUSES.includes(job.status) || !can(role, "automation:run")) return null;
  const confirmedAfterRequest =
    job.manual_action_confirmed_at &&
    job.manual_action_requested_at &&
    job.manual_action_confirmed_at >= job.manual_action_requested_at;
  return (
    <Button
      size="sm"
      className="bg-orange-500 text-white hover:bg-orange-600"
      disabled={pending || Boolean(confirmedAfterRequest)}
      onClick={() =>
        start(async () => {
          const res = await confirmManualAction(job.id);
          if (res.ok) toast.success(res.message);
          else toast.error(res.error);
          router.refresh();
        })
      }
    >
      {pending ? <Loader2 className="animate-spin" /> : <PlayCircle />}
      {confirmedAfterRequest ? "Confirmado" : "Continuar automação"}
    </Button>
  );
}

export function JobActions({ job, role }: { job: AutomationJob; role: UserRole }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const canCancel = can(role, "automation:cancel") && !FINAL_JOB_STATUSES.includes(job.status) && !job.cancel_requested;
  const canRetry = can(role, "automation:retry") && RETRYABLE_JOB_STATUSES.includes(job.status);

  function run(fn: (id: string) => Promise<{ ok: boolean; message?: string; error?: string }>) {
    start(async () => {
      const res = await fn(job.id);
      if (res.ok) toast.success(res.message);
      else toast.error(res.error);
      router.refresh();
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Ações" disabled={pending}>
          {pending ? <Loader2 className="animate-spin" /> : <MoreHorizontal />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem asChild>
          <Link href={`/history/${job.id}`}>
            <Eye /> Detalhes e logs
          </Link>
        </DropdownMenuItem>
        {canRetry || canCancel ? <DropdownMenuSeparator /> : null}
        {canRetry ? (
          <DropdownMenuItem onSelect={() => run(retryJob)}>
            <RotateCcw /> Reprocessar
          </DropdownMenuItem>
        ) : null}
        {canCancel ? (
          <DropdownMenuItem variant="destructive" onSelect={() => run(cancelJob)}>
            <Ban /> Cancelar
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
