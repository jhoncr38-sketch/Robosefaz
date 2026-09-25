import { cn } from "@/lib/utils";
import {
  CERTIFICATE_STATUS_LABEL,
  certificateTone,
  JOB_STATUS_LABEL,
  jobTone,
  TASK_STATUS_LABEL,
  taskTone,
  type Tone,
} from "@/lib/status";
import type { CertificateStatus, JobStatus, TaskStatus } from "@/lib/types";

const TONE_CLASS: Record<Tone, string> = {
  gray: "bg-zinc-100 text-zinc-700 ring-zinc-200",
  blue: "bg-sky-50 text-sky-700 ring-sky-200",
  yellow: "bg-amber-50 text-amber-800 ring-amber-200",
  green: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  red: "bg-red-50 text-red-700 ring-red-200",
  orange: "bg-orange-50 text-orange-700 ring-orange-200",
};

const DOT_CLASS: Record<Tone, string> = {
  gray: "bg-zinc-400",
  blue: "bg-sky-500 animate-pulse",
  yellow: "bg-amber-500",
  green: "bg-emerald-500",
  red: "bg-red-500",
  orange: "bg-orange-500 animate-pulse",
};

export function ToneBadge({ tone, children, className }: { tone: Tone; children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset",
        TONE_CLASS[tone],
        className,
      )}
    >
      <span className={cn("size-1.5 rounded-full", DOT_CLASS[tone])} aria-hidden />
      {children}
    </span>
  );
}

export function JobStatusBadge({ status }: { status: JobStatus }) {
  return <ToneBadge tone={jobTone(status)}>{JOB_STATUS_LABEL[status] ?? status}</ToneBadge>;
}

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  return <ToneBadge tone={taskTone(status)}>{TASK_STATUS_LABEL[status] ?? status}</ToneBadge>;
}

export function CertificateStatusBadge({ status }: { status: CertificateStatus }) {
  return <ToneBadge tone={certificateTone(status)}>{CERTIFICATE_STATUS_LABEL[status]}</ToneBadge>;
}
