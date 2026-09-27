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
  gray: "bg-[#f1f1ef] text-[#6b6b66]",
  blue: "bg-[#e8f1fd] text-[#1d5fb8]",
  yellow: "bg-[#fdf4e3] text-[#9a6205]",
  green: "bg-[#e8f6ee] text-[#1c7a47]",
  red: "bg-[#fdecec] text-[#b42323]",
  orange: "bg-[#fdeee3] text-[#b4530f]",
  purple: "bg-[#f3eefc] text-[#6b3fb8]",
};

const DOT_CLASS: Record<Tone, string> = {
  gray: "bg-[#a3a39e]",
  blue: "bg-[#3b82e0] animate-pulse",
  yellow: "bg-[#e0a019]",
  green: "bg-[#2ea062]",
  red: "bg-[#dc3b3b]",
  orange: "bg-[#f97316] animate-pulse",
  purple: "bg-[#8b5cf6]",
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
