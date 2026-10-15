import { redirect } from "next/navigation";

// A aba Erros saiu do menu: era o Histórico filtrado. Links antigos caem no filtro "Com erro".
export default function ErrorsPage() {
  redirect("/history?status=erro");
}
