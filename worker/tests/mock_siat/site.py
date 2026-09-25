"""SIAT simulado para testes de integração do Playwright.

Reproduz o caminho real observado em 24/09/2026:
  login (certificado) -> /painel-aplicacoes/callback -> painel (contribuinte com CNPJ)
  -> card "e-AGEAT" (às vezes "Error 500" ou "Usuário não identificado")
  -> "Autorregularização" > "SIAT" -> SIAT web legado (/siatweb/...)
  -> "Autoatendimento" > "NFC-e" > "Consultar/Exportar NFC-e"
                       > "NF-e"  > "Consultar/Exportar NF-e"
com os formulários e listas (ID, Situação, IE, Download) do portal.
As requisições são interceptadas com `context.route` — nada sai para a internet.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field

from playwright.async_api import Route

# Domínio .invalid (RFC 2606) nunca resolve: se algo escapar da interceptação,
# o teste falha em vez de acessar o SIAT real.
BASE = "https://siat-mock.invalid"


@dataclass
class MockState:
    certificates: list[str] = field(
        default_factory=lambda: [
            "EMPRESA B LTDA:11444777000161 - AC TESTE RFB v5 - b@b.com",
            "EMPRESA A LTDA:11222333000181 - AC TESTE RFB v5 - a@a.com",
        ]
    )
    taxpayers: list[tuple[str, str, str]] = field(
        default_factory=lambda: [
            ("987654321", "11.444.777/0001-61", "EMPRESA B LTDA"),
            ("123456789", "11.222.333/0001-81", "EMPRESA A LTDA"),
        ]
    )
    # quando definido, o portal "abre" outro contribuinte (teste de segurança)
    force_header_cnpj: str | None = None
    # retorno do login trava para sempre
    callback_always_hangs: bool = False
    # e-AGEAT: nova aba; "Error 500" nas N primeiras; depois "Usuário não identificado" nas M seguintes
    module_new_tab: bool = True
    module_fail_times: int = 0
    module_unidentified_times: int = 0
    module_opens: int = 0
    # SIAT web legado
    legacy_user: str = "EMPRESA A LTDA"
    inscricoes: list[str] = field(default_factory=lambda: ["123456789"])
    # IE exibida nas linhas da lista (None = a IE informada no agendamento)
    rows_ie_override: str | None = None
    export_status: str = "Processado"
    scheduled: list[dict] = field(default_factory=list)
    downloads_served: int = 0


LOGIN_HTML = """<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>SIAT WEB</title></head>
<body>
  <h1>SIAT WEB</h1>
  <button id="cert">Certificado Digital</button>
  <div id="dlg" class="v-dialog" role="dialog" style="display:none">
    <div class="v-card__title">Selecione um Certificado</div>
    <table><tbody id="rows"></tbody></table>
  </div>
<script>
const certs = __CERTS__;
document.getElementById('cert').onclick = () => {
  const tb = document.getElementById('rows');
  tb.innerHTML = '';
  certs.forEach((c) => {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td>' + c + '</td>';
    tr.onclick = () => { sessionStorage.setItem('cert', c); location.href = '/painel-aplicacoes/callback?code=abc'; };
    tb.appendChild(tr);
  });
  const d = document.getElementById('dlg');
  d.style.display = 'block';
  d.classList.add('v-dialog--active');
};
</script></body></html>"""

# Retorno do Keycloak: com dados antigos no localStorage ("stale") o SPA trava,
# como observado no SIAT real em um perfil com sessão anterior.
CALLBACK_HTML = """<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>SIAT WEB</title></head>
<body><div id="nuxt-loading" role="status">carregando...</div>
<script>
const hangs = __HANGS__;
if (hangs || localStorage.getItem('stale') === '1') {
  console.error('Falha ao trocar o código de autorização');
} else {
  setTimeout(() => { location.href = '/painel-aplicacoes/main'; }, 300);
}
</script></body></html>"""

SERVER_ERROR_HTML = """<html><body><h2>Error 500--Internal Server Error</h2>
<p>The server encountered an unexpected condition which prevented it from fulfilling the request.</p></body></html>"""

UNIDENTIFIED_HTML = """<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>e-AGEAT</title></head>
<body><h1>Acesso proibido</h1>
<div class="alert"><strong>Usuário não identificado</strong><p>Clique no botão para efetuar o login.</p></div>
<a class="btn" href="/carta-de-servicos">Efetuar login</a></body></html>"""

PAINEL_HTML = """<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Painel de aplicações | SIAT WEB</title></head>
<body>
<header>
  <span>USUÁRIO</span>
  <span id="current">Contribuinte: nenhum</span>
  <button id="logout">Sair</button>
</header>
<h1>PAINEL DE APLICAÇÕES</h1>
<nav>
  <button id="open-tp">Selecionar Contribuinte</button>
  <a href="/eageat/jsp/login/bemVindo.jsf" id="module" __TARGET__>e-AGEAT</a>
  <a href="#">Incentivos ICMS - Indústria</a>
</nav>
<div id="tp" class="v-dialog" role="dialog" style="display:none">
  <span class="titulo">Selecionar Contribuinte</span>
  <label for="doc">CPF/CNPJ</label><input id="doc">
  <button id="search">Consultar</button>
  <table>
    <thead><tr><th>Inscrição</th><th>CPF/CNPJ</th><th>Nome/Razão Social</th><th>Situação Cadastral</th><th>Ações</th></tr></thead>
    <tbody id="tp-rows"></tbody>
  </table>
</div>
<script>
const taxpayers = __TAXPAYERS__;
const forced = __FORCED__;
const $ = (id) => document.getElementById(id);
function setCurrent(cnpj, name) {
  const shown = forced || cnpj;
  $('current').textContent = 'Contribuinte: ' + name + ' - ' + shown;
  localStorage.setItem('tp', JSON.stringify([shown, name]));
}
const saved = localStorage.getItem('tp');
if (saved) { const [c, n] = JSON.parse(saved); $('current').textContent = 'Contribuinte: ' + n + ' - ' + c; }
$('logout').onclick = () => { localStorage.removeItem('tp'); location.href = '/painel-aplicacoes/login'; };
$('open-tp').onclick = () => { $('tp').style.display = 'block'; $('tp').classList.add('v-dialog--active'); };
$('search').onclick = () => {
  const q = $('doc').value.replace(/\\D/g, '');
  const tb = $('tp-rows'); tb.innerHTML = '';
  taxpayers.filter(([ie, doc]) => !q || doc.replace(/\\D/g, '') === q).forEach(([ie, doc, name]) => {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td>' + ie + '</td><td>' + doc + '</td><td>' + name + '</td><td>ATIVO</td><td><button title="selecionar">✓</button></td>';
    tr.querySelector('button').onclick = () => { setCurrent(doc, name); $('tp').style.display = 'none'; };
    tb.appendChild(tr);
  });
};
</script></body></html>"""

EAGEAT_HTML = """<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>e-Processo</title></head>
<body>
<nav>
  <a href="#" id="dd">Autorregularização</a>
  <ul id="menu" style="display:none">
    <li><a href="#">Controle de Acesso</a></li>
    <li><a href="#">Malhas Fiscais</a></li>
    <li><a href="/siatweb/faces/index.xhtml?faces-redirect=true">SIAT</a></li>
    <li><a href="#">SISAT</a></li>
    <li><a href="#">NF-e</a></li>
  </ul>
  <a href="#">Contribuinte</a> <a href="#">Ajuda</a>
  <a href="#">SIAT WEB</a> <span>Usuário</span>
</nav>
<h2>Domicílio Tributário Eletrônico (DT-e)</h2>
<script>
document.getElementById('dd').onclick = (e) => { e.preventDefault(); document.getElementById('menu').style.display = 'block'; };
</script></body></html>"""

LEGACY_HTML = """<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>SIAT - Sistema Integrado de Administração Tributária</title>
<style>.sub{display:none} .open > .sub{display:block}</style></head>
<body>
<div id="topo">SIAT web</div>
<ul id="menubar">
  <li id="root"><a href="#" id="auto">Autoatendimento</a>
    <ul class="sub" id="auto-sub">
      <li><a href="#">Cadastro</a></li>
      <li class="grp"><a href="#">NFC-e</a>
        <ul class="sub"><li><a href="#" data-go="nfce">Consultar/Exportar NFC-e</a></li><li><a href="#">Manutenção de CSC</a></li></ul>
      </li>
      <li class="grp"><a href="#">NF-e</a>
        <ul class="sub"><li><a href="#" data-go="none">Consultar/Exportar NF-e Detalhada</a></li><li><a href="#" data-go="nfe">Consultar/Exportar NF-e</a></li></ul>
      </li>
    </ul>
  </li>
  <li><a href="#">Trânsito</a></li>
</ul>
<div>Usuário: <span id="user">__USER__</span> <a href="#">Pagina Inicial</a> <a href="#">Sair</a></div>
<div class="ui-messages" id="msg" style="display:none"></div>

<section id="nfce" style="display:none">
  <h3>Consultar NFCE</h3>
  <input type="radio" name="c-tipo" id="c-emit"><label for="c-emit">Contribuinte como Emitente</label>
  <input type="radio" name="c-tipo" id="c-dest"><label for="c-dest">Contribuinte como Destinatário</label>
  <label for="c-insc">Inscrição::</label><select id="c-insc">__OPTIONS__</select>
  Tipo de nota: <input type="radio" name="c-nota" id="c-ent"><label for="c-ent">Entrada</label>
  <input type="radio" name="c-nota" id="c-sai"><label for="c-sai">Saída</label>
  Status da NFC-e: <input type="radio" name="c-st" id="c-at"><label for="c-at">Ativas</label>
  <input type="radio" name="c-st" id="c-ca"><label for="c-ca">Canceladas</label>
  <input type="radio" name="c-st" id="c-to"><label for="c-to">Todas</label>
  <label for="c-serie">Série</label><input id="c-serie">
  <label for="c-ini">Data de Emissão Inicial</label><input id="c-ini">
  <label for="c-fim">Data de Emissão Final</label><input id="c-fim">
  <button id="c-agendar">Agendar exportação</button>
  <h4>Agendamentos de exportação NFCe</h4>
  <table id="c-table"><thead><tr><th>ID</th><th>Situação</th><th>Data de criação</th><th>IE</th><th>Data processamento</th><th>Ações</th></tr></thead><tbody></tbody></table>
</section>

<section id="nfe" style="display:none">
  <h3>Consultar NFE</h3>
  <input type="radio" name="n-tipo" id="n-chave" checked><label for="n-chave">Pesquisar SOMENTE pela Chave da NFE</label>
  <input type="radio" name="n-tipo" id="n-emit"><label for="n-emit">Contribuinte como Emitente</label>
  <input type="radio" name="n-tipo" id="n-dest"><label for="n-dest">Contribuinte como Destinatário</label>
  <div id="n-chave-box"><label for="n-ch">Chave NFE (DANFE):</label><input id="n-ch"><button>Exportar</button></div>
  <div id="n-periodo" style="display:none">
    <label for="n-insc">Inscrição:</label><select id="n-insc">__OPTIONS__</select>
    <label for="n-ini">Data de Emissão Inicial</label><input id="n-ini">
    <label for="n-fim">Data de Emissão Final</label><input id="n-fim">
    <button id="n-agendar">Agendar exportação</button>
  </div>
  <h4>Exportação de Notas Fiscais Agendadas</h4>
  <table id="n-table"><thead><tr><th>ID</th><th>Situação</th><th>Data de criação</th><th>CNPJ<select><option>Selecione...</option></select></th><th>IE<select><option>Selecione...</option></select></th><th>Data processamento</th><th>Ações</th></tr></thead><tbody></tbody></table>
</section>
<script>
const $ = (id) => document.getElementById(id);
const status = __STATUS__;
const ieOverride = __IE_OVERRIDE__;
$('auto').onclick = (e) => { e.preventDefault(); $('root').classList.add('open'); };
document.querySelectorAll('.grp').forEach((g) => { g.onmouseenter = () => { document.querySelectorAll('.grp').forEach(x => x.classList.remove('open')); g.classList.add('open'); }; });
document.querySelectorAll('[data-go]').forEach((a) => a.onclick = (e) => {
  e.preventDefault();
  $('root').classList.remove('open');
  document.querySelectorAll('.grp').forEach(x => x.classList.remove('open'));
  if (a.dataset.go === 'none') return;
  $('nfce').style.display = a.dataset.go === 'nfce' ? 'block' : 'none';
  $('nfe').style.display = a.dataset.go === 'nfe' ? 'block' : 'none';
  $('msg').style.display = 'none';
  render();
});
['n-chave', 'n-emit', 'n-dest'].forEach((id) => $(id).onchange = () => {
  const periodo = !$('n-chave').checked;
  $('n-periodo').style.display = periodo ? 'block' : 'none';
  $('n-chave-box').style.display = periodo ? 'none' : 'block';
});
function reqs() { return JSON.parse(localStorage.getItem('reqs') || '[]'); }
function fmtIe(ie) { return ie.slice(0, -1) + '-' + ie.slice(-1); }
function render() {
  for (const fam of ['nfce', 'nfe']) {
    const tb = $(fam === 'nfce' ? 'c-table' : 'n-table').querySelector('tbody');
    tb.innerHTML = '';
    reqs().filter(r => r.family === fam).slice().reverse().forEach((r) => {
      const tr = document.createElement('tr');
      const ie = fmtIe(ieOverride || r.ie);
      tr.innerHTML = '<td>' + r.id + '</td><td>' + status + '</td><td>' + r.created + '</td>' +
        (fam === 'nfe' ? '<td></td>' : '') + '<td>' + ie + '</td><td>' + r.created + '</td>' +
        '<td><button>Info</button><button class="dl">Download</button><button>Excluir</button></td>';
      tr.querySelector('.dl').onclick = async () => {
        const res = await fetch('/siatweb/api/download/' + r.id);
        const blob = await res.blob();
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'export_' + r.id + '.zip';
        document.body.appendChild(link); link.click(); link.remove();
      };
      tb.appendChild(tr);
    });
  }
}
async function agendar(fam) {
  const p = fam === 'nfce'
    ? { tipo: $('c-emit').checked ? 'emitente' : ($('c-dest').checked ? 'destinatario' : ''), ie: $('c-insc').value,
        nota: $('c-sai').checked ? 'saida' : ($('c-ent').checked ? 'entrada' : ''),
        status: $('c-at').checked ? 'ativas' : ($('c-ca').checked ? 'canceladas' : ($('c-to').checked ? 'todas' : '')),
        ini: $('c-ini').value, fim: $('c-fim').value }
    : { tipo: $('n-emit').checked ? 'emitente' : ($('n-dest').checked ? 'destinatario' : ''), ie: $('n-insc').value,
        ini: $('n-ini').value, fim: $('n-fim').value };
  const missing = !p.tipo || !p.ie || !p.ini || !p.fim || (fam === 'nfce' && (!p.nota || !p.status));
  $('msg').style.display = 'block';
  if (missing) { $('msg').textContent = 'Erro: preencha os campos obrigatórios.'; return; }
  const res = await fetch('/siatweb/api/agendar', { method: 'POST', body: JSON.stringify({ family: fam, ...p }) });
  const r = await res.json();
  const all = reqs(); all.push(r); localStorage.setItem('reqs', JSON.stringify(all));
  $('msg').textContent = 'Agendamento realizado com sucesso!';
  render();
}
$('c-agendar').onclick = () => agendar('nfce');
$('n-agendar').onclick = () => agendar('nfe');
render();
</script></body></html>"""


def _options(state: MockState) -> str:
    return '<option value="">Selecione</option>' + "".join(f"<option>{ie}</option>" for ie in state.inscricoes)


def build_handler(state: MockState):
    async def html(route: Route, body: str, status: int = 200) -> None:
        await route.fulfill(status=status, content_type="text/html; charset=utf-8", body=body)

    async def handler(route: Route) -> None:
        url = route.request.url
        path = url.replace(BASE, "").split("?")[0]
        if path.startswith("/painel-aplicacoes/login"):
            await html(route, LOGIN_HTML.replace("__CERTS__", json.dumps(state.certificates)))
        elif path.startswith("/painel-aplicacoes/callback"):
            await html(route, CALLBACK_HTML.replace("__HANGS__", json.dumps(state.callback_always_hangs)))
        elif path.startswith("/painel-aplicacoes/main"):
            await html(
                route,
                PAINEL_HTML.replace("__TAXPAYERS__", json.dumps(state.taxpayers))
                .replace("__FORCED__", json.dumps(state.force_header_cnpj))
                .replace("__TARGET__", 'target="_blank"' if state.module_new_tab else ""),
            )
        elif path.startswith("/carta-de-servicos"):
            await html(route, "<h1>CARTA DE SERVIÇOS</h1><h2>APLICAÇÕES PÚBLICAS</h2><button>ENTRAR</button>")
        elif path.startswith("/eageat"):
            state.module_opens += 1
            if state.module_opens <= state.module_fail_times:
                await html(route, SERVER_ERROR_HTML, status=500)
            elif state.module_opens <= state.module_fail_times + state.module_unidentified_times:
                await html(route, UNIDENTIFIED_HTML)
            else:
                await html(route, EAGEAT_HTML)
        elif path.startswith("/siatweb/api/agendar"):
            params = json.loads(route.request.post_data or "{}")
            request_id = str(9237950 + len(state.scheduled))
            state.scheduled.append({**params, "id": request_id})
            await route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({**params, "id": request_id, "created": "24/09/2026 23:30:00"}),
            )
        elif path.startswith("/siatweb/api/download/"):
            req_id = path.rsplit("/", 1)[-1]
            state.downloads_served += 1
            await route.fulfill(status=200, content_type="application/zip", body=b"PK\x03\x04 conteudo " + req_id.encode())
        elif path.startswith("/siatweb"):
            await html(
                route,
                LEGACY_HTML.replace("__USER__", state.legacy_user)
                .replace("__OPTIONS__", _options(state))
                .replace("__STATUS__", json.dumps(state.export_status))
                .replace("__IE_OVERRIDE__", json.dumps(state.rows_ie_override)),
            )
        else:
            await route.fulfill(status=404, body="not found")

    return handler
