"use client";

import { Bell, CheckCheck } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { markAllNotificationsRead, markNotificationRead } from "@/app/actions/misc";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { formatRelative } from "@/lib/format";
import { createClient } from "@/lib/supabase/client";
import type { NotificationRow } from "@/lib/types";
import { cn } from "@/lib/utils";

const LEVEL_DOT: Record<NotificationRow["level"], string> = {
  info: "bg-sky-500",
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  error: "bg-red-500",
};

export function NotificationsBell({ userId }: { userId: string }) {
  const [items, setItems] = useState<NotificationRow[]>([]);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from("notifications")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(30);
    setItems((data ?? []) as NotificationRow[]);
  }, []);

  useEffect(() => {
    const supabase = createClient();
    // carga inicial fora do corpo síncrono do efeito
    const initial = setTimeout(() => void load(), 0);
    const channel = supabase
      .channel(`notifications:${userId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${userId}` },
        (payload) => {
          const n = payload.new as NotificationRow;
          setItems((prev) => [n, ...prev].slice(0, 30));
          const show = n.level === "error" ? toast.error : n.level === "success" ? toast.success : n.level === "warning" ? toast.warning : toast.info;
          show(n.title, { description: n.message });
        },
      )
      .subscribe();
    return () => {
      clearTimeout(initial);
      void supabase.removeChannel(channel);
    };
  }, [userId, load]);

  const unread = items.filter((n) => !n.read_at).length;

  async function readOne(n: NotificationRow) {
    if (n.read_at) return;
    setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x)));
    await markNotificationRead(n.id);
  }

  async function readAll() {
    setItems((prev) => prev.map((x) => ({ ...x, read_at: x.read_at ?? new Date().toISOString() })));
    await markAllNotificationsRead();
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label="Notificações">
          <Bell />
          {unread > 0 ? (
            <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white">
              {unread > 9 ? "9+" : unread}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0">
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <p className="text-sm font-medium">Notificações</p>
          <Button variant="ghost" size="xs" onClick={readAll} disabled={unread === 0}>
            <CheckCheck /> Marcar todas como lidas
          </Button>
        </div>
        <ScrollArea className="max-h-96">
          {items.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">Nenhuma notificação.</p>
          ) : (
            <ul className="divide-y">
              {items.map((n) => {
                const content = (
                  <div className={cn("flex gap-3 px-4 py-3 text-left", !n.read_at && "bg-emerald-50/40")}>
                    <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", LEVEL_DOT[n.level])} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{n.title}</p>
                      <p className="text-xs text-muted-foreground">{n.message}</p>
                      <p className="mt-1 text-[11px] text-muted-foreground">{formatRelative(n.created_at)}</p>
                    </div>
                  </div>
                );
                return (
                  <li key={n.id}>
                    {n.link ? (
                      <Link
                        href={n.link}
                        className="block hover:bg-muted/60"
                        onClick={() => {
                          void readOne(n);
                          setOpen(false);
                        }}
                      >
                        {content}
                      </Link>
                    ) : (
                      <button type="button" className="block w-full hover:bg-muted/60" onClick={() => void readOne(n)}>
                        {content}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
