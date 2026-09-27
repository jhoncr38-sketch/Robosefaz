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

// cores das pílulas do redesenho (fundo / texto / ponto)
const TONE_CLASS: Record<Tone, string> = {
  gray: "bg-(--c-f1f1ef) text-(--c-6b6b66)",
  blue: "bg-(--c-e8f1fd) text-(--c-1d5fb8)",
  yellow: "bg-(--c-fdf4e3) text-(--c-9a6205)",
  green: "bg-(--c-e8f6ee) text-(--c-1c7a47)",
  red: "bg-(--c-fdecec) text-(--c-b42323)",
  orange: "bg-(--c-fdeee3) text-(--c-b4530f)",
  purple: "bg-(--c-f3eefc) text-(--c-6b3fb8)",
};

const DOT_CLASS: Record<Tone, string> = {
  gray: "bg-(--c-a3a39e)",
  blue: "bg-(--c-3b82e0) animate-pulse",
  yellow: "bg-(--c-e0a019)",
  green: "bg-(--c-2ea062)",
  red: "bg-(--c-dc3b3b)",
  orange: "bg-(--c-f97316) animate-pulse",
  purple: "bg-(--c-8b5cf6)",
};

export function ToneBadge({ tone, children, className }: { tone: Tone; children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-[5px] px-2 py-0.5 text-xs font-medium whitespace-nowrap",
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
