"use client";

import { LogOut, Menu, UserRound } from "lucide-react";
import { useState } from "react";

import { NotificationsBell } from "@/components/layout/notifications-bell";
import { Brand, SidebarNav } from "@/components/layout/sidebar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { ROLE_LABEL } from "@/lib/permissions";
import type { Profile } from "@/lib/types";

export function Header({ profile }: { profile: Profile }) {
  const [open, setOpen] = useState(false);
  const initials = (profile.name || profile.email)
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b bg-background/85 px-4 backdrop-blur lg:px-8">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Abrir menu">
            <Menu />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-64 p-0">
          <SheetHeader className="border-b py-4">
            <SheetTitle asChild>
              <div>
                <Brand />
              </div>
            </SheetTitle>
          </SheetHeader>
          <div className="py-3">
            <SidebarNav role={profile.role} onNavigate={() => setOpen(false)} />
          </div>
        </SheetContent>
      </Sheet>

      <div className="flex-1" />
      <NotificationsBell userId={profile.user_id} />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="h-9 gap-2 px-2">
            <span className="flex size-7 items-center justify-center rounded-full bg-emerald-100 text-xs font-semibold text-emerald-800">
              {initials || <UserRound className="size-4" />}
            </span>
            <span className="hidden text-left leading-tight sm:block">
              <span className="block text-sm font-medium">{profile.name || profile.email}</span>
              <span className="block text-[11px] text-muted-foreground">{ROLE_LABEL[profile.role]}</span>
            </span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel className="font-normal">
            <p className="text-sm font-medium">{profile.name}</p>
            <p className="truncate text-xs text-muted-foreground">{profile.email}</p>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <form action="/auth/signout" method="post">
            <DropdownMenuItem asChild>
              <button type="submit" className="w-full">
                <LogOut /> Sair
              </button>
            </DropdownMenuItem>
          </form>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
