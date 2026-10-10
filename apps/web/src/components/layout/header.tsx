"use client";

import { ChevronRight, LogOut, Menu, Monitor, Moon, Sun, UserRound } from "lucide-react";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { GlobalSearch } from "@/components/layout/global-search";
import { navLocation, type NavCounts, type NavFolderState } from "@/components/layout/nav-items";
import { NotificationsBell } from "@/components/layout/notifications-bell";
import { RobotStatusPill } from "@/components/layout/robot-status-pill";
import { Brand, SidebarNav } from "@/components/layout/sidebar";
import { saveMenuStyle, useMenuStyle } from "@/components/layout/sidebar-state";
import { saveTheme, useThemeChoice, type ThemeChoice } from "@/components/theme/theme";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { ROLE_LABEL } from "@/lib/permissions";
import type { MenuStyle } from "@/lib/theme-boot";
import type { Profile } from "@/lib/types";

export function Header({
  profile,
  counts,
  folderState,
}: {
  profile: Profile;
  counts: NavCounts;
  folderState: NavFolderState;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const theme = useThemeChoice();
  const menuStyle = useMenuStyle();
  const where = navLocation(pathname);
  const displayName = profile.name || profile.email;
  const initials = displayName
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 1)
    .join("")
    .toUpperCase();

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-4 border-b bg-card/90 px-4 backdrop-blur-[6px] lg:px-6">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon" className="-mr-2 lg:hidden" aria-label="Abrir menu">
            <Menu />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-[260px] gap-0 border-(--sb-border) bg-(--sb-bg) p-0">
          <SheetHeader className="border-b border-(--sb-line) px-4 py-4">
            <SheetTitle asChild>
              <div>
                <Brand />
              </div>
            </SheetTitle>
          </SheetHeader>
          <div className="overflow-y-auto py-2">
            <SidebarNav
              role={profile.role}
              isOwner={profile.is_platform_owner}
              counts={counts}
              folderState={folderState}
              onNavigate={() => setOpen(false)}
            />
          </div>
        </SheetContent>
      </Sheet>

      {where ? (
        // sem espaço, o grupo ("Robô ›") some inteiro (quebra para a 2ª linha, escondida); o nome da página fica
        <div className="hidden h-5 min-w-[70px] flex-row-reverse flex-wrap items-center justify-end gap-x-2 overflow-hidden text-[13px] leading-5 whitespace-nowrap text-(--c-6b6c66) md:flex">
          <span className="min-w-0 truncate font-medium text-foreground">{where.label}</span>
          <span className="flex items-center gap-2">
            {where.group}
            <ChevronRight className="size-3" />
          </span>
        </div>
      ) : null}

      <div className="flex min-w-[140px] flex-1 justify-center">
        <GlobalSearch />
      </div>

      <RobotStatusPill />
      <NotificationsBell userId={profile.user_id} />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex shrink-0 items-center gap-2 rounded-lg px-1 py-1 whitespace-nowrap hover:bg-(--c-f2f3ef)"
          >
            <span className="flex size-[30px] items-center justify-center rounded-full bg-(--c-dff1e6) text-[12.5px] font-semibold text-primary">
              {initials || <UserRound className="size-4" />}
            </span>
            <span className="hidden text-left leading-tight sm:block">
              <span className="block max-w-36 truncate text-[13px] font-medium">{displayName.split(/\s+/)[0]}</span>
              <span className="block text-[11px] text-(--c-6b6c66)">{ROLE_LABEL[profile.role]}</span>
            </span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel className="font-normal">
            <p className="text-sm font-medium">{profile.name}</p>
            <p className="truncate text-xs text-muted-foreground">{profile.email}</p>
            {profile.organizations?.name ? (
              <p className="mt-1 truncate text-xs text-muted-foreground">{profile.organizations.name}</p>
            ) : null}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Tema</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={theme} onValueChange={(v) => saveTheme(v as ThemeChoice)}>
            <DropdownMenuRadioItem value="light" onSelect={(e) => e.preventDefault()}>
              <Sun /> Claro
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="dark" onSelect={(e) => e.preventDefault()}>
              <Moon /> Noturno
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="system" onSelect={(e) => e.preventDefault()}>
              <Monitor /> Automático (igual ao Windows)
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Menu lateral</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={menuStyle} onValueChange={(v) => saveMenuStyle(v as MenuStyle)}>
            <DropdownMenuRadioItem value="branco" onSelect={(e) => e.preventDefault()}>
              <span aria-hidden className="size-[15px] rounded-[4px] border border-(--c-d4d4cf) bg-white" /> Claro
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="escuro" onSelect={(e) => e.preventDefault()}>
              <span aria-hidden className="size-[15px] rounded-[4px] bg-[#14241c]" /> Escuro
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
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
