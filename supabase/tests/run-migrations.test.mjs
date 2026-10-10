// Executa as migrations em um Postgres real (PGlite/WASM) com stubs do Supabase
// (schemas auth/storage, papéis anon/authenticated/service_role, publicação realtime)
// e valida RLS, RPCs, duplicidade, fila com lock, auditoria e notificações.
//
// Uso: cd supabase/tests && npm install && npm test

import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "migrations");

const SUPABASE_STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb default '{}'::jsonb,
  raw_app_meta_data jsonb default '{}'::jsonb,
  last_sign_in_at timestamptz
);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', 'anon')
$$;
grant execute on all functions in schema auth to anon, authenticated, service_role;

create schema storage;
create table storage.buckets (id text primary key, name text, public boolean default false);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;

create publication supabase_realtime;
`;

const db = new PGlite({ extensions: { pgcrypto } });
let passed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}\n       ${err.message}`);
    process.exitCode = 1;
  }
}

// Executa como um usuário (ou service_role) dentro de uma transação.
async function as(identity, fn) {
  return db.transaction(async (tx) => {
    if (identity === "service_role") {
      await tx.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
      await tx.exec("set local role service_role");
    } else if (identity === "anon") {
      await tx.query(`select set_config('request.jwt.claims', '{"role":"anon"}', true)`);
      await tx.exec("set local role anon");
    } else {
      const claims = JSON.stringify({ sub: identity, role: "authenticated" });
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [claims]);
      await tx.exec("set local role authenticated");
    }
    return fn(tx);
  });
}

async function rejects(promise, pattern) {
  try {
    await promise;
  } catch (err) {
    if (pattern && !pattern.test(err.message)) {
      throw new Error(`erro inesperado: ${err.message}`);
    }
    return;
  }
  throw new Error("era esperado erro");
}

console.log("Aplicando stubs do Supabase e migrations...");
await db.exec(SUPABASE_STUBS);
const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
for (const file of files) {
  await db.exec(readFileSync(join(migrationsDir, file), "utf8"));
  console.log(`  migration ${file}`);
}

const newUser = async (email, appMeta = {}, userMeta = {}) =>
  (
    await db.query(
      "insert into auth.users (email, raw_app_meta_data, raw_user_meta_data) values ($1, $2, $3) returning id",
      [email, appMeta, userMeta],
    )
  ).rows[0].id;

const ADMIN = await newUser("admin@x.com");
// escritório do primeiro usuário (o painel informa org_id no app_metadata dos convidados)
const ORG_A = (await db.query("select org_id from public.profiles where email = 'admin@x.com'")).rows[0].org_id;
const OPERATOR = await newUser("op@x.com", { role: "operator", org_id: ORG_A });
const VIEWER = await newUser("viewer@x.com", { org_id: ORG_A });
// tentativa de escalonamento via user_metadata (controlado pelo próprio usuário)
await newUser("zz-hacker@x.com", {}, { role: "admin", org_id: ORG_A });

console.log("Testes:");

await test("primeiro usuário vira admin; papel só via app_metadata (sem escalonamento)", async () => {
  const { rows } = await db.query("select email, role from public.profiles order by email");
  assert.deepEqual(rows, [
    { email: "admin@x.com", role: "admin" },
    { email: "op@x.com", role: "operator" },
    { email: "viewer@x.com", role: "viewer" },
    { email: "zz-hacker@x.com", role: "viewer" },
  ]);
});

await test("validação de CNPJ no banco (numérico e alfanumérico)", async () => {
  const { rows } = await db.query(
    "select public.is_valid_cnpj('11222333000181') a, public.is_valid_cnpj('11222333000182') b, public.is_valid_cnpj('12ABC34501DE35') c, public.is_valid_cnpj('00000000000000') d",
  );
  assert.deepEqual(rows[0], { a: true, b: false, c: true, d: false });
});

let CLIENT_A;
let CLIENT_B;
await test("admin cadastra clientes; client_code sequencial CLI000001", async () => {
  await as(ADMIN, async (tx) => {
    const a = await tx.query(
      "insert into public.clients (legal_name, cnpj) values ('Empresa A LTDA', '11222333000181') returning id, client_code",
    );
    const b = await tx.query(
      "insert into public.clients (legal_name, cnpj, uses_nfce) values ('Empresa B LTDA', '11444777000161', false) returning id, client_code",
    );
    CLIENT_A = a.rows[0].id;
    CLIENT_B = b.rows[0].id;
    assert.equal(a.rows[0].client_code, "CLI000001");
    assert.equal(b.rows[0].client_code, "CLI000002");
  });
});

await test("CNPJ inválido é rejeitado", async () => {
  await rejects(
    as(ADMIN, (tx) => tx.query("insert into public.clients (legal_name, cnpj) values ('X', '11222333000182')")),
    /clients_cnpj_valid/,
  );
});

await test("RLS: visualizador não cadastra; operador cadastra/edita mas não exclui; anon não lê nada", async () => {
  await rejects(
    as(VIEWER, (tx) => tx.query("insert into public.clients (legal_name, cnpj) values ('X', '04252011000110')")),
    /row-level security/,
  );
  const op = await as(OPERATOR, (tx) =>
    tx.query("insert into public.clients (legal_name, cnpj) values ('Do Operador', '04252011000110') returning id"),
  );
  const opClient = op.rows[0].id;
  const edit = await as(OPERATOR, (tx) => tx.query("update public.clients set trade_name = 'Editado' where id = $1", [opClient]));
  assert.equal(edit.affectedRows, 1);
  const viewerEdit = await as(VIEWER, (tx) => tx.query("update public.clients set trade_name = 'X' where id = $1", [opClient]));
  assert.equal(viewerEdit.affectedRows, 0);
  const del = await as(OPERATOR, (tx) => tx.query("delete from public.clients where id = $1", [opClient]));
  assert.equal(del.affectedRows, 0, "operador não exclui empresa");
  await as(ADMIN, (tx) => tx.query("delete from public.clients where id = $1", [opClient]));
  await rejects(as("anon", (tx) => tx.query("select * from public.clients")), /permission denied/);
  const { rows } = await as(VIEWER, (tx) => tx.query("select count(*)::int n from public.clients"));
  assert.equal(rows[0].n, 2);
});

await test("certificado: status calculado e perfil = client_id", async () => {
  await as(ADMIN, async (tx) => {
    await tx.query(
      "insert into public.certificates (client_id, subject_name, valid_until) values ($1, 'EMPRESA A:11222333000181', now() + interval '10 days')",
      [CLIENT_A],
    );
    const { rows } = await tx.query("select status, browser_profile from public.certificates where client_id = $1", [CLIENT_A]);
    assert.equal(rows[0].status, "expiring");
    assert.equal(rows[0].browser_profile, CLIENT_A);
  });
  await rejects(
    as(ADMIN, (tx) =>
      tx.query("insert into public.certificates (client_id, subject_name, valid_until) values ($1, 'dup', now() + interval '1 year')", [CLIENT_A]),
    ),
    /certificates_one_active_per_client/,
  );
});

let JOB_A;
await test("operator cria job; tarefas NFC-e/NF-e emitidas/recebidas", async () => {
  const res = await as(OPERATOR, (tx) =>
    tx.query("select public.create_automation_job($1, '2026-08', '{NFCE_EXPORT,NFE_ISSUED_EXPORT,NFE_RECEIVED_EXPORT}') r", [CLIENT_A]),
  );
  const r = res.rows[0].r;
  assert.equal(r.duplicate, false);
  JOB_A = r.job_id;
  const job = (await db.query("select start_date::text s, end_date::text e, created_by, status from public.automation_jobs where id = $1", [JOB_A])).rows[0];
  assert.deepEqual(job, { s: "2026-08-01", e: "2026-08-31", created_by: OPERATOR, status: "queued" });
  const tasks = (await db.query("select dedup_key from public.automation_tasks where job_id = $1 order by task_type", [JOB_A])).rows;
  assert.equal(tasks.length, 3);
  assert.equal(tasks[0].dedup_key, `${CLIENT_A}|2026-08|NFCE|EXPORT`);
});

await test("duplicidade: segunda solicitação retorna 'Exportação já agendada.'", async () => {
  const res = await as(OPERATOR, (tx) =>
    tx.query("select public.create_automation_job($1, '2026-08', '{NFCE_EXPORT}') r", [CLIENT_A]),
  );
  assert.equal(res.rows[0].r.duplicate, true);
  assert.equal(res.rows[0].r.message, "Exportação já agendada.");
});

await test("forçar novo agendamento: operador pode, visualizador não", async () => {
  await rejects(
    as(VIEWER, (tx) => tx.query("select public.create_automation_job($1, '2026-08', '{NFCE_EXPORT}', true)", [CLIENT_A])),
    /FORBIDDEN/,
  );
  const res = await as(OPERATOR, (tx) =>
    tx.query("select public.create_automation_job($1, '2026-08', '{NFCE_EXPORT}', true) r", [CLIENT_A]),
  );
  assert.equal(res.rows[0].r.duplicate, false);
  const { rows } = await db.query("select count(*)::int n from public.automation_tasks where superseded");
  assert.equal(rows[0].n, 1);
});

await test("viewer não cria jobs; competência inválida é rejeitada", async () => {
  await rejects(as(VIEWER, (tx) => tx.query("select public.create_automation_job($1, '2026-08', '{NFCE_EXPORT}')", [CLIENT_B])), /FORBIDDEN/);
  await rejects(as(OPERATOR, (tx) => tx.query("select public.create_automation_job($1, '2026-13', '{NFCE_EXPORT}')", [CLIENT_B])), /INVALID_COMPETENCE/);
});

await test("lote respeita configuração do cliente (B não usa NFC-e)", async () => {
  const res = await as(OPERATOR, (tx) =>
    tx.query("select public.create_automation_jobs_batch($1, '2026-08', '{NFCE_EXPORT,NFE_ISSUED_EXPORT}') r", [[CLIENT_B]]),
  );
  const [r] = res.rows[0].r;
  assert.deepEqual(r.operations, ["NFE_ISSUED_EXPORT"]);
});

await test("fila: claim com lock e sem paralelismo no mesmo cliente", async () => {
  await rejects(as(OPERATOR, (tx) => tx.query("select * from public.claim_next_job('w1')")), /permission denied|FORBIDDEN/);
  const first = await as("service_role", (tx) => tx.query("select id, client_id, status, locked_by, attempts from public.claim_next_job('w1')"));
  assert.equal(first.rows[0].status, "starting");
  assert.equal(first.rows[0].locked_by, "w1");
  assert.equal(first.rows[0].attempts, 1);
  const second = await as("service_role", (tx) => tx.query("select id, client_id from public.claim_next_job('w2')"));
  // o outro job do mesmo cliente fica bloqueado; pega o do cliente B
  assert.notEqual(second.rows[0].client_id, first.rows[0].client_id);
  const third = await as("service_role", (tx) => tx.query("select id from public.claim_next_job('w3')"));
  assert.equal(third.rows.length, 0);
});

await test("notificação e auditoria ao concluir; confirmação manual; cancelamento", async () => {
  await db.query("update public.automation_jobs set status = 'manual_action_required' where id = $1", [JOB_A]);
  await rejects(as(VIEWER, (tx) => tx.query("select public.confirm_manual_action($1)", [JOB_A])), /FORBIDDEN/);
  await as(OPERATOR, (tx) => tx.query("select public.confirm_manual_action($1)", [JOB_A]));
  const job = (await db.query("select manual_action_confirmed_by from public.automation_jobs where id = $1", [JOB_A])).rows[0];
  assert.equal(job.manual_action_confirmed_by, OPERATOR);

  await db.query("update public.automation_jobs set status = 'completed' where id = $1", [JOB_A]);
  const notes = await as(OPERATOR, (tx) => tx.query("select title from public.notifications"));
  assert.ok(notes.rows.some((n) => n.title === "Automação concluída."));
  const other = await as(VIEWER, (tx) => tx.query("select count(*)::int n from public.notifications"));
  assert.equal(other.rows[0].n, 0, "notificações são privadas por usuário");

  await rejects(as(OPERATOR, (tx) => tx.query("select public.cancel_automation_job($1)", [JOB_A])), /INVALID_STATE/);
  const audits = await as(ADMIN, (tx) => tx.query("select action from public.audit_logs"));
  const actions = audits.rows.map((r) => r.action);
  for (const a of ["client.created", "certificate.created", "automation.started", "automation.manual_action_confirmed"]) {
    assert.ok(actions.includes(a), `faltou auditoria ${a}`);
  }
  await rejects(
    as(OPERATOR, async (tx) => {
      const r = await tx.query("select count(*)::int n from public.audit_logs");
      if (r.rows[0].n === 0) throw new Error("row-level security: operador não vê auditoria");
    }),
    /row-level security/,
  );
});

await test("reprocessar: operador pode, visualizador não; job volta para a fila", async () => {
  await db.query("update public.automation_jobs set status = 'failed', locked_by = null where id = $1", [JOB_A]);
  await db.query("update public.automation_tasks set status = 'failed' where job_id = $1", [JOB_A]);
  await rejects(as(VIEWER, (tx) => tx.query("select public.retry_automation_job($1)", [JOB_A])), /FORBIDDEN/);
  await as(OPERATOR, (tx) => tx.query("select public.retry_automation_job($1)", [JOB_A]));
  const { rows } = await db.query("select status, attempts from public.automation_jobs where id = $1", [JOB_A]);
  assert.deepEqual(rows[0], { status: "queued", attempts: 0 });
  const tasks = (await db.query("select status from public.automation_tasks where job_id = $1 order by status", [JOB_A])).rows.map((r) => r.status);
  // NFC-e foi re-agendada por outro job (forçado) -> skipped; demais voltam a pending
  assert.deepEqual(tasks, ["pending", "pending", "skipped"]);
});

await test("locks órfãos são liberados", async () => {
  await db.query("update public.automation_jobs set locked_at = now() - interval '2 hours' where locked_by is not null");
  const { rows } = await as("service_role", (tx) => tx.query("select public.release_stale_locks(30) n"));
  assert.ok(rows[0].n >= 1);
});

await test("dashboard, alertas de certificado e storage privado", async () => {
  const stats = (await as(VIEWER, (tx) => tx.query("select public.dashboard_stats() s"))).rows[0].s;
  assert.equal(stats.clients_active, 2);
  assert.equal(stats.certificates_expiring, 1);
  const n = (await as("service_role", (tx) => tx.query("select public.generate_certificate_expiry_notifications() n"))).rows[0].n;
  assert.equal(n, 1);
  const again = (await as("service_role", (tx) => tx.query("select public.generate_certificate_expiry_notifications() n"))).rows[0].n;
  assert.equal(again, 1);
  const count = (await db.query("select count(*)::int n from public.notifications where title = 'Certificado vencendo.'")).rows[0].n;
  assert.equal(count, 2, "um alerta por admin/operador, sem duplicar no mesmo dia");
  const buckets = (await db.query("select id, public from storage.buckets order by id")).rows;
  assert.deepEqual(buckets, [
    { id: "certificates", public: false },
    { id: "fiscal-downloads", public: false },
  ]);
});

await test("usuário não altera o próprio papel", async () => {
  await rejects(
    as(VIEWER, async (tx) => {
      const r = await tx.query("update public.profiles set role = 'admin' where user_id = $1", [VIEWER]);
      if (r.affectedRows === 0) throw new Error("row-level security bloqueou");
    }),
    /row-level security/,
  );
  const r = await as(VIEWER, (tx) => tx.query("update public.profiles set name = 'Novo Nome' where user_id = $1", [VIEWER]));
  assert.equal(r.affectedRows, 1);
});

// ---------------------------------------------------------------------
// Organizações: um escritório nunca enxerga nem altera dados de outro
// ---------------------------------------------------------------------
let ORG_B;
let ADMIN_B;
let CLIENT_B1;
await test("organizações: primeiro admin é o dono da plataforma; escritório inicial com todos os dados", async () => {
  const owner = (await db.query("select is_platform_owner from public.profiles where email = 'admin@x.com'")).rows[0];
  assert.equal(owner.is_platform_owner, true);
  const others = (await db.query("select count(*)::int n from public.profiles where is_platform_owner and email <> 'admin@x.com'")).rows[0];
  assert.equal(others.n, 0);
  const hacker = (await db.query("select org_id from public.profiles where email = 'zz-hacker@x.com'")).rows[0];
  assert.equal(hacker.org_id, null, "org_id em user_metadata é ignorado");
  const orphan = (await db.query("select count(*)::int n from public.clients where org_id is null")).rows[0];
  assert.equal(orphan.n, 0);
});

await test("só o dono da plataforma cria escritórios", async () => {
  await rejects(as(OPERATOR, (tx) => tx.query("insert into public.organizations (name) values ('Pirata')")), /row-level security/);
  const r = await as(ADMIN, (tx) => tx.query("insert into public.organizations (name) values ('Escritório B') returning id"));
  ORG_B = r.rows[0].id;
  ADMIN_B = await newUser("admin-b@y.com", { role: "admin", org_id: ORG_B });
  const p = (await db.query("select org_id, role, is_platform_owner from public.profiles where user_id = $1", [ADMIN_B])).rows[0];
  assert.deepEqual(p, { org_id: ORG_B, role: "admin", is_platform_owner: false });
});

await test("escritório B: mesmo CNPJ de A é permitido e o código recomeça em CLI000001", async () => {
  const r = await as(ADMIN_B, (tx) =>
    tx.query(
      "insert into public.clients (legal_name, cnpj, org_id) values ('Empresa A no B', '11222333000181', $1) returning id, client_code, org_id",
      [ORG_A],
    ),
  );
  CLIENT_B1 = r.rows[0].id;
  assert.equal(r.rows[0].client_code, "CLI000001");
  assert.equal(r.rows[0].org_id, ORG_B, "org_id informado pelo usuário é ignorado: vai para o próprio escritório");
  await rejects(
    as(ADMIN_B, (tx) => tx.query("insert into public.clients (legal_name, cnpj) values ('Dup', '11222333000181')")),
    /clients_org_cnpj_key/,
  );
});

await test("isolamento de leitura: cada escritório só vê os próprios dados", async () => {
  for (const table of ["clients", "certificates", "automation_jobs", "automation_tasks", "automation_logs", "downloads", "audit_logs"]) {
    const b = await as(ADMIN_B, (tx) => tx.query(`select count(*)::int n from public.${table} where org_id <> $1`, [ORG_B]));
    assert.equal(b.rows[0].n, 0, `B viu dados de outro escritório em ${table}`);
    const a = await as(ADMIN, (tx) => tx.query(`select count(*)::int n from public.${table} where org_id <> $1`, [ORG_A]));
    assert.equal(a.rows[0].n, 0, `A (dono da plataforma) viu dados de outro escritório em ${table}`);
  }
  const clientsA = await as(VIEWER, (tx) => tx.query("select count(*)::int n from public.clients"));
  assert.equal(clientsA.rows[0].n, 2);
  const stats = (await as(ADMIN_B, (tx) => tx.query("select public.dashboard_stats() s"))).rows[0].s;
  assert.equal(stats.clients_active, 1);
  const profiles = await as(ADMIN_B, (tx) => tx.query("select email from public.profiles order by email"));
  assert.deepEqual(profiles.rows.map((r) => r.email), ["admin-b@y.com"]);
});

await test("isolamento de escrita: B não altera, agenda, cancela nem reprocessa nada de A", async () => {
  const upd = await as(ADMIN_B, (tx) => tx.query("update public.clients set legal_name = 'HACK' where id = $1", [CLIENT_A]));
  assert.equal(upd.affectedRows, 0);
  const del = await as(ADMIN_B, (tx) => tx.query("delete from public.clients where id = $1", [CLIENT_A]));
  assert.equal(del.affectedRows, 0);
  await rejects(
    as(ADMIN_B, (tx) =>
      tx.query(
        "insert into public.certificates (client_id, subject_name, valid_until) values ($1, 'x', now() + interval '1 year')",
        [CLIENT_B],
      ),
    ),
    /row-level security/,
  );
  await rejects(
    as(ADMIN_B, (tx) => tx.query("select public.create_automation_job($1, '2026-07', '{NFCE_EXPORT}')", [CLIENT_A])),
    /CLIENT_NOT_FOUND/,
  );
  await rejects(as(ADMIN_B, (tx) => tx.query("select public.cancel_automation_job($1)", [JOB_A])), /JOB_NOT_FOUND/);
  await rejects(as(ADMIN_B, (tx) => tx.query("select public.retry_automation_job($1)", [JOB_A])), /JOB_NOT_FOUND/);
  await db.query("update public.automation_jobs set status = 'manual_action_required' where id = $1", [JOB_A]);
  await rejects(as(ADMIN_B, (tx) => tx.query("select public.confirm_manual_action($1)", [JOB_A])), /INVALID_STATE/);
  const batch = await as(ADMIN_B, (tx) =>
    tx.query("select public.create_automation_jobs_batch($1, '2026-07', '{NFE_ISSUED_EXPORT}') r", [[CLIENT_A]]),
  );
  assert.equal(batch.rows[0].r[0].job_id, null);
  const name = (await db.query("select legal_name from public.clients where id = $1", [CLIENT_A])).rows[0].legal_name;
  assert.equal(name, "Empresa A LTDA");
});

await test("B não se move para outro escritório nem vira dono da plataforma", async () => {
  await as(ADMIN_B, (tx) =>
    tx.query("update public.profiles set org_id = $1, is_platform_owner = true where user_id = $2", [ORG_A, ADMIN_B]),
  );
  const p = (await db.query("select org_id, is_platform_owner from public.profiles where user_id = $1", [ADMIN_B])).rows[0];
  assert.deepEqual(p, { org_id: ORG_B, is_platform_owner: false });
  const org = await as(ADMIN_B, (tx) => tx.query("update public.organizations set max_clients = 9999 where id = $1", [ORG_B]));
  assert.equal(org.affectedRows, 0, "limite do plano só o dono da plataforma altera");
});

await test("job de B: tarefas/logs herdam o escritório; notificações só para B", async () => {
  const r = await as(ADMIN_B, (tx) =>
    tx.query("select public.create_automation_job($1, '2026-08', '{NFE_ISSUED_EXPORT}') r", [CLIENT_B1]),
  );
  const jobB = r.rows[0].r.job_id;
  await as("service_role", (tx) =>
    tx.query("insert into public.automation_logs (job_id, message) values ($1, 'robô antigo sem org_id')", [jobB]),
  );
  const orgs = (
    await db.query(
      "select (select org_id from public.automation_jobs where id = $1) j, (select array_agg(distinct org_id) from public.automation_tasks where job_id = $1) t, (select array_agg(distinct org_id) from public.automation_logs where job_id = $1) l",
      [jobB],
    )
  ).rows[0];
  assert.equal(orgs.j, ORG_B);
  assert.deepEqual(orgs.t, [ORG_B]);
  assert.deepEqual(orgs.l, [ORG_B]);
  await db.query("update public.automation_jobs set created_by = null where id = $1", [jobB]);
  await db.query("update public.automation_jobs set status = 'completed' where id = $1", [jobB]);
  const leaked = (
    await db.query(
      "select count(*)::int n from public.notifications n join public.profiles p on p.user_id = n.user_id where n.link = $1 and p.org_id <> $2",
      [`/history/${jobB}`, ORG_B],
    )
  ).rows[0].n;
  assert.equal(leaked, 0, "aviso do job de B chegou a outro escritório");
  const got = (
    await db.query("select count(*)::int n from public.notifications where user_id = $1 and link = $2", [ADMIN_B, `/history/${jobB}`])
  ).rows[0].n;
  assert.equal(got, 1);
});

await test("limite do plano e escritório suspenso", async () => {
  await as(ADMIN, (tx) => tx.query("update public.organizations set max_clients = 1 where id = $1", [ORG_B]));
  await rejects(
    as(ADMIN_B, (tx) => tx.query("insert into public.clients (legal_name, cnpj) values ('Outra', '11444777000161')")),
    /PLAN_LIMIT/,
  );
  await as(ADMIN, (tx) => tx.query("update public.organizations set status = 'suspended' where id = $1", [ORG_B]));
  const seen = await as(ADMIN_B, (tx) => tx.query("select count(*)::int n from public.clients"));
  assert.equal(seen.rows[0].n, 0, "escritório suspenso não acessa nada");
  await rejects(
    as(ADMIN_B, (tx) => tx.query("select public.create_automation_job($1, '2026-06', '{NFE_ISSUED_EXPORT}')", [CLIENT_B1])),
    /FORBIDDEN/,
  );
  const ownerStill = await as(ADMIN, (tx) => tx.query("select count(*)::int n from public.clients"));
  assert.equal(ownerStill.rows[0].n, 2);
  await as(ADMIN, (tx) => tx.query("update public.organizations set status = 'active', max_clients = null where id = $1", [ORG_B]));
});

await test("painel do dono: números por escritório, sem acesso para os demais", async () => {
  await rejects(as(ADMIN_B, (tx) => tx.query("select * from public.platform_organizations()")), /FORBIDDEN/);
  const rows = (await as(ADMIN, (tx) => tx.query("select name, clients, users from public.platform_organizations()"))).rows;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.find((r) => r.name === "Escritório B"), { name: "Escritório B", clients: 1, users: 1 });
});

// ---------------------------------------------------------------------
// Computadores (robôs): ativação por código e isolamento por escritório
// ---------------------------------------------------------------------
async function activateDevice(adminId, name) {
  const code = (await as(adminId, (tx) => tx.query("select public.create_device_activation_code() r"))).rows[0].r.code;
  const redeemed = (
    await as("service_role", (tx) => tx.query("select public.redeem_device_activation_code($1, $2) r", [code, name]))
  ).rows[0].r;
  const authId = (
    await db.query(
      "insert into auth.users (email, raw_app_meta_data) values ($1, $2) returning id",
      [`robo-${redeemed.device_id}@robos.test`, { kind: "device", org_id: redeemed.org_id, device_id: redeemed.device_id }],
    )
  ).rows[0].id;
  await db.query("update public.devices set auth_user_id = $1 where id = $2", [authId, redeemed.device_id]);
  return { code, authId, deviceId: redeemed.device_id, orgId: redeemed.org_id };
}

let DEVICE_A;
let DEVICE_B;
await test("ativação: só admin gera código; uso único; robô não vira usuário do painel", async () => {
  await rejects(as(OPERATOR, (tx) => tx.query("select public.create_device_activation_code()")), /FORBIDDEN/);
  DEVICE_A = await activateDevice(ADMIN, "PC-ESCRITORIO-A");
  DEVICE_B = await activateDevice(ADMIN_B, "PC-ESCRITORIO-B");
  assert.equal(DEVICE_A.orgId, ORG_A);
  assert.equal(DEVICE_B.orgId, ORG_B);
  assert.match(DEVICE_A.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  await rejects(
    as("service_role", (tx) => tx.query("select public.redeem_device_activation_code($1, 'X')", [DEVICE_A.code])),
    /INVALID_CODE/,
  );
  await rejects(
    as(ADMIN, (tx) => tx.query("select public.redeem_device_activation_code('AAAA-BBBB', 'X')")),
    /permission denied/,
  );
  const profile = (await db.query("select count(*)::int n from public.profiles where user_id = $1", [DEVICE_A.authId])).rows[0].n;
  assert.equal(profile, 0);
  const stored = (await db.query("select count(*)::int n from public.device_activation_codes where code_hash = $1", [DEVICE_A.code])).rows[0].n;
  assert.equal(stored, 0, "código guardado só como hash");
});

await test("código expirado não ativa", async () => {
  const code = (await as(ADMIN, (tx) => tx.query("select public.create_device_activation_code() r"))).rows[0].r.code;
  await db.query("update public.device_activation_codes set expires_at = now() - interval '1 minute' where used_at is null");
  await rejects(
    as("service_role", (tx) => tx.query("select public.redeem_device_activation_code($1, 'X')", [code])),
    /INVALID_CODE/,
  );
});

await test("robô só lê os dados do próprio escritório", async () => {
  const a = await as(DEVICE_A.authId, (tx) => tx.query("select distinct org_id from public.clients"));
  assert.deepEqual(a.rows.map((r) => r.org_id), [ORG_A]);
  const b = await as(DEVICE_B.authId, (tx) => tx.query("select distinct org_id from public.clients"));
  assert.deepEqual(b.rows.map((r) => r.org_id), [ORG_B]);
  for (const table of ["automation_jobs", "automation_tasks", "downloads", "certificates"]) {
    const leak = await as(DEVICE_B.authId, (tx) => tx.query(`select count(*)::int n from public.${table} where org_id <> $1`, [ORG_B]));
    assert.equal(leak.rows[0].n, 0, `robô de B leu ${table} de outro escritório`);
  }
  const panel = await as(DEVICE_A.authId, (tx) => tx.query("select count(*)::int n from public.profiles"));
  assert.equal(panel.rows[0].n, 0, "robô não lê usuários");
});

await test("fila: robô de B só pega jobs de B; robô de A nunca pega jobs de B", async () => {
  await db.query("update public.automation_jobs set locked_by = null, locked_at = null");
  const jobB = (
    await as(ADMIN_B, (tx) => tx.query("select public.create_automation_job($1, '2026-05', '{NFE_ISSUED_EXPORT}') r", [CLIENT_B1]))
  ).rows[0].r.job_id;
  const fromA = await as(DEVICE_A.authId, (tx) => tx.query("select id, org_id from public.claim_next_job('robo-a')"));
  for (const row of fromA.rows) assert.equal(row.org_id, ORG_A);
  const fromB = await as(DEVICE_B.authId, (tx) => tx.query("select id, org_id from public.claim_next_job('robo-b')"));
  assert.equal(fromB.rows[0].id, jobB);
  const again = await as(DEVICE_B.authId, (tx) => tx.query("select id from public.claim_next_job('robo-b2')"));
  assert.equal(again.rows.length, 0, "B não tem mais trabalho e não pega o de A");
  await rejects(as(OPERATOR, (tx) => tx.query("select * from public.claim_next_job('humano')")), /FORBIDDEN/);
});

await test("robô grava só no próprio escritório (logs, tarefas, downloads, sinal de vida)", async () => {
  const jobA = (await db.query("select id from public.automation_jobs where org_id = $1 limit 1", [ORG_A])).rows[0].id;
  await rejects(
    as(DEVICE_B.authId, (tx) => tx.query("insert into public.automation_logs (job_id, message) values ($1, 'invasão')", [jobA])),
    /row-level security/,
  );
  const upd = await as(DEVICE_B.authId, (tx) => tx.query("update public.automation_jobs set last_message = 'hack' where id = $1", [jobA]));
  assert.equal(upd.affectedRows, 0);
  await as(DEVICE_B.authId, (tx) =>
    tx.query("insert into public.worker_heartbeats (worker_id, kind, meta) values ('PC-B-1', 'all', '{\"version\":\"1.1.0\"}')"),
  );
  await as(DEVICE_B.authId, (tx) => tx.query("insert into public.automation_logs (job_id, message) values (null, 'mensagem geral do robô')"));
  // como o robô grava de verdade: a biblioteca pede a linha de volta (RETURNING)
  const jobOfB = (await db.query("select id from public.automation_jobs where org_id = $1 limit 1", [ORG_B])).rows[0].id;
  for (const [table, sql, params] of [
    ["automation_logs", "insert into public.automation_logs (job_id, message) values ($1, 'com returning') returning *", [jobOfB]],
    ["automation_tasks", "insert into public.automation_tasks (job_id, client_id, task_type, competence) values ($1, $2, 'CHECK_PROCESSING', '2026-05') returning *", [jobOfB, CLIENT_B1]],
    ["automation_jobs", "update public.automation_jobs set last_message = 'robô' where id = $1 returning *", [jobOfB]],
    // registro de download com upsert: a 2ª vez (mesmo arquivo) cai no ON CONFLICT DO UPDATE
    ...[1, 2].map(() => [
      "downloads",
      "insert into public.downloads (client_id, job_id, document_type, competence, filename, filepath, checksum) values ($1, $2, 'NFCE', '2026-05', 'x.zip', 'C:/x.zip', repeat('b', 64)) on conflict (client_id, competence, document_type, checksum) do update set filepath = excluded.filepath returning *",
      [CLIENT_B1, jobOfB],
    ]),
    ["audit_logs", "insert into public.audit_logs (action, entity, client_id) values ('certificate.secret_saved', 'certificate', $1) returning *", [CLIENT_B1]],
  ]) {
    const r = await as(DEVICE_B.authId, (tx) => tx.query(sql, params));
    assert.equal(r.rows.length, 1, `robô não conseguiu gravar em ${table} com RETURNING`);
  }
  const general = (await db.query("select org_id from public.automation_logs where message = 'mensagem geral do robô'")).rows[0];
  assert.equal(general.org_id, ORG_B);
  const hb = (await db.query("select org_id, device_id from public.worker_heartbeats where worker_id = 'PC-B-1'")).rows[0];
  assert.deepEqual(hb, { org_id: ORG_B, device_id: DEVICE_B.deviceId });
  const dev = (await db.query("select robot_version, last_seen_at is not null seen from public.devices where id = $1", [DEVICE_B.deviceId])).rows[0];
  assert.deepEqual(dev, { robot_version: "1.1.0", seen: true });
  const seenByA = await as(DEVICE_A.authId, (tx) => tx.query("select count(*)::int n from public.worker_heartbeats where worker_id = 'PC-B-1'"));
  assert.equal(seenByA.rows[0].n, 0);
});

await test("robô grava o código do Google Drive só nos downloads do próprio escritório", async () => {
  const id = (await db.query("select id from public.downloads where org_id = $1 and filename = 'x.zip'", [ORG_B])).rows[0].id;
  const DRIVE_ID = "1jIOcup0tsxX4h2TCXGwS0YYtSbGRh33v";
  const byA = await as(DEVICE_A.authId, (tx) => tx.query("update public.downloads set drive_file_id = $2 where id = $1", [id, DRIVE_ID]));
  assert.equal(byA.affectedRows, 0);
  const byB = await as(DEVICE_B.authId, (tx) => tx.query("update public.downloads set drive_file_id = $2 where id = $1 returning drive_file_id", [id, DRIVE_ID]));
  assert.equal(byB.rows[0].drive_file_id, DRIVE_ID);
  // o painel monta o link com o código: nada além do formato de ID do Drive
  await rejects(
    as(DEVICE_B.authId, (tx) => tx.query("update public.downloads set drive_file_id = 'https://evil.example/x' where id = $1", [id])),
    /downloads_drive_file_id_format/,
  );
  // pastas ano/mês e ano/mês/cliente ("Baixar todas")
  const folders = await as(DEVICE_B.authId, (tx) =>
    tx.query(
      "update public.downloads set drive_client_folder_id = $2, drive_month_folder_id = $3 where id = $1 returning drive_month_folder_id",
      [id, "1DB4jzRLko3Xm3ZtWdC4235rCAf7v8-Xp", "17sSm4IpL_iXnBG2hyRVQ6Kw_YUUVaCLX"],
    ),
  );
  assert.equal(folders.rows[0].drive_month_folder_id, "17sSm4IpL_iXnBG2hyRVQ6Kw_YUUVaCLX");
  await rejects(
    as(DEVICE_B.authId, (tx) => tx.query("update public.downloads set drive_month_folder_id = 'javascript:alert(1)' where id = $1", [id])),
    /downloads_drive_folders_format/,
  );
});

await test("computador ativado sabe o próprio escritório (para marcar a pasta das notas)", async () => {
  const b = await as(DEVICE_B.authId, (tx) => tx.query("select id, name from public.device_org()"));
  assert.deepEqual(b.rows, [{ id: ORG_B, name: "Escritório B" }]);
  const a = await as(DEVICE_A.authId, (tx) => tx.query("select id from public.device_org()"));
  assert.deepEqual(a.rows, [{ id: ORG_A }]);
  // pessoa (não computador) não recebe nada
  const human = await as(ADMIN_B, (tx) => tx.query("select * from public.device_org()"));
  assert.equal(human.rows.length, 0);
  await rejects(as("anon", (tx) => tx.query("select * from public.device_org()")), /permission denied/);
});

await test("robô grava a quantidade de notas só nos downloads do próprio escritório", async () => {
  const id = (await db.query("select id from public.downloads where org_id = $1 and filename = 'x.zip'", [ORG_B])).rows[0].id;
  const byA = await as(DEVICE_A.authId, (tx) => tx.query("update public.downloads set note_count = 5 where id = $1", [id]));
  assert.equal(byA.affectedRows, 0);
  const byB = await as(DEVICE_B.authId, (tx) =>
    tx.query("update public.downloads set note_count = 2308 where id = $1 returning note_count", [id]),
  );
  assert.equal(byB.rows[0].note_count, 2308);
  await rejects(
    as(DEVICE_B.authId, (tx) => tx.query("update public.downloads set note_count = -1 where id = $1", [id])),
    /downloads_note_count_check/,
  );
  // o robô procura as que faltam contar
  const pending = await as(DEVICE_B.authId, (tx) =>
    tx.query("select count(*)::int n from public.downloads where note_count is null and id = $1", [id]),
  );
  assert.equal(pending.rows[0].n, 0);
});

await test("sem movimento: uma linha por cliente, mês e tipo, só sem arquivo e só do próprio escritório", async () => {
  const jobOfB = (await db.query("select id from public.automation_jobs where org_id = $1 limit 1", [ORG_B])).rows[0].id;
  const task = (type, doc, result, finished) =>
    db.query(
      `insert into public.automation_tasks (job_id, client_id, task_type, status, competence, document_type, result, finished_at)
       values ($1, $2, $3, 'completed', '2026-05', $4, $5, $6) returning id`,
      [jobOfB, CLIENT_B1, type, doc, result, finished],
    );
  await task("NFCE_EXPORT", "NFCE", { no_notes: true }, "2026-06-01T10:00:00Z"); // já tem o x.zip de NFC-e de 05/2026
  await task("NFE_ISSUED_EXPORT", "NFE_EMITIDAS", { no_notes: true }, "2026-06-01T10:00:00Z");
  const latest = (await task("NFE_ISSUED_EXPORT", "NFE_EMITIDAS", { no_notes: true, raw_status: "ZIP vazio" }, "2026-06-02T10:00:00Z")).rows[0].id;
  await task("NFE_RECEIVED_EXPORT", "NFE_RECEBIDAS", {}, "2026-06-01T10:00:00Z"); // concluído com arquivo, não é sem movimento
  const b = await as(ADMIN_B, (tx) =>
    tx.query("select id, document_type, competence from public.downloads_no_movement where client_id = $1", [CLIENT_B1]),
  );
  assert.deepEqual(b.rows, [{ id: latest, document_type: "NFE_EMITIDAS", competence: "2026-05" }]);
  const a = await as(ADMIN, (tx) => tx.query("select count(*)::int n from public.downloads_no_movement"));
  assert.equal(a.rows[0].n, 0, "outro escritório não vê");
  await rejects(as("anon", (tx) => tx.query("select * from public.downloads_no_movement")), /permission denied/);
});

await test("painel lista só os computadores do próprio escritório", async () => {
  const a = await as(ADMIN, (tx) => tx.query("select name from public.devices"));
  assert.deepEqual(a.rows.map((r) => r.name), ["PC-ESCRITORIO-A"]);
  const b = await as(ADMIN_B, (tx) => tx.query("select name from public.devices"));
  assert.deepEqual(b.rows.map((r) => r.name), ["PC-ESCRITORIO-B"]);
  await rejects(as(ADMIN, (tx) => tx.query("select public.revoke_device($1)", [DEVICE_B.deviceId])), /DEVICE_NOT_FOUND/);
});

await test("computador desativado perde o acesso na hora", async () => {
  await as(ADMIN_B, (tx) => tx.query("select public.revoke_device($1)", [DEVICE_B.deviceId]));
  const seen = await as(DEVICE_B.authId, (tx) => tx.query("select count(*)::int n from public.clients"));
  assert.equal(seen.rows[0].n, 0);
  await rejects(as(DEVICE_B.authId, (tx) => tx.query("select * from public.claim_next_job('robo-b')")), /FORBIDDEN/);
});

await test("escritório suspenso: robô dele também para", async () => {
  await as(ADMIN, (tx) => tx.query("update public.organizations set status = 'suspended' where id = $1", [ORG_A]));
  await rejects(as(DEVICE_A.authId, (tx) => tx.query("select * from public.claim_next_collection('robo-a')")), /FORBIDDEN/);
  await as(ADMIN, (tx) => tx.query("update public.organizations set status = 'active' where id = $1", [ORG_A]));
  const ok = await as(DEVICE_A.authId, (tx) => tx.query("select count(*)::int n from public.clients"));
  assert.ok(ok.rows[0].n > 0);
});

// ---------------------------------------------------------------------
// Consulta do processamento da EFD (DT-e)
// ---------------------------------------------------------------------
let EFD_JOB;
await test("EFD: operador pede a consulta; visualizador não; pedido repetido é ignorado", async () => {
  await rejects(
    as(VIEWER, (tx) => tx.query("select public.create_efd_check_jobs($1, '2026-08')", [[CLIENT_A]])),
    /FORBIDDEN/,
  );
  const first = (await as(OPERATOR, (tx) => tx.query("select public.create_efd_check_jobs($1, '2026-08') r", [[CLIENT_A]]))).rows[0].r;
  assert.equal(first.created, 1);
  EFD_JOB = first.results[0].job_id;
  const job = (await db.query("select operations, status, org_id from public.automation_jobs where id = $1", [EFD_JOB])).rows[0];
  assert.equal(job.status, "queued");
  assert.equal(job.org_id, ORG_A);
  assert.match(String(job.operations), /EFD_CHECK/);
  const tasks = (await db.query("select task_type, document_type, dedup_key from public.automation_tasks where job_id = $1", [EFD_JOB])).rows;
  assert.deepEqual(tasks, [{ task_type: "EFD_CHECK", document_type: null, dedup_key: null }]);
  const again = (await as(OPERATOR, (tx) => tx.query("select public.create_efd_check_jobs($1, '2026-08') r", [[CLIENT_A]]))).rows[0].r;
  assert.deepEqual([again.created, again.skipped], [0, 1]);
  // outro escritório não pede consulta para cliente de A
  await rejects(as(ADMIN_B, (tx) => tx.query("select public.create_efd_check_jobs($1, '2026-08')", [[CLIENT_A]])), /CLIENT_NOT_FOUND|FORBIDDEN/);
});

await test("EFD: robô antigo não pega a consulta; robô 1.2.0 pega", async () => {
  // só a consulta de EFD na fila de A
  await db.query("update public.automation_jobs set status = 'cancelled' where org_id = $1 and status = 'queued' and id <> $2", [ORG_A, EFD_JOB]);
  await db.query("update public.automation_jobs set locked_by = null, locked_at = null");
  await as(DEVICE_A.authId, (tx) =>
    tx.query(`insert into public.worker_heartbeats (worker_id, kind, meta) values
      ('PC-A-ANTIGO', 'all', '{"version":"1.1.3"}'), ('PC-A-NOVO', 'all', '{"version":"1.2.0"}')`),
  );
  const old = await as(DEVICE_A.authId, (tx) => tx.query("select id from public.claim_next_job('PC-A-ANTIGO')"));
  assert.equal(old.rows.length, 0, "robô 1.1.3 não deve pegar consulta de EFD");
  const unknown = await as(DEVICE_A.authId, (tx) => tx.query("select id from public.claim_next_job('sem-sinal')"));
  assert.equal(unknown.rows.length, 0, "robô sem versão conhecida não pega consulta de EFD");
  const fresh = await as(DEVICE_A.authId, (tx) => tx.query("select id from public.claim_next_job('PC-A-NOVO')"));
  assert.equal(fresh.rows[0].id, EFD_JOB);
});

await test("EFD: robô grava declarações com upsert pelo EPE; painel lê só o próprio escritório", async () => {
  const sql = `insert into public.efd_declarations (client_id, job_id, competence, epe_number, finalidade, processed, situation, inconsistencies)
               values ($1, $2, '2026-08', '93104981381', 'ORIGINAL', true, $3, $4)
               on conflict (org_id, epe_number) do update set situation = excluded.situation, inconsistencies = excluded.inconsistencies
               returning *`;
  for (const situation of ["processed", "alert"]) {
    const r = await as(DEVICE_A.authId, (tx) => tx.query(sql, [CLIENT_A, EFD_JOB, situation, JSON.stringify([{ type: 3 }])]));
    assert.equal(r.rows.length, 1);
  }
  const rows = (await as(OPERATOR, (tx) => tx.query("select situation, org_id from public.efd_declarations"))).rows;
  assert.deepEqual(rows, [{ situation: "alert", org_id: ORG_A }]);
  const fromB = await as(ADMIN_B, (tx) => tx.query("select count(*)::int n from public.efd_declarations"));
  assert.equal(fromB.rows[0].n, 0);
  // painel não grava declarações (só o robô)
  await rejects(
    as(ADMIN, (tx) => tx.query("insert into public.efd_declarations (client_id, competence, epe_number, situation) values ($1, '2026-08', '1', 'processed')", [CLIENT_A])),
    /row-level security/,
  );
  await rejects(
    db.query("insert into public.efd_declarations (client_id, competence, epe_number, situation) values ($1, '2026-08', '2', 'ok')", [CLIENT_A]),
    /efd_declarations_situation/,
  );
});

await test("EFD: conclusão avisa com o resultado; reprocessar recoloca a consulta na fila", async () => {
  await db.query("update public.automation_jobs set status = 'completed', last_message = 'EFD 08/2026: processada com malha' where id = $1", [EFD_JOB]);
  const n = (await db.query("select title, message, link from public.notifications where dedup_key = $1 limit 1", [`job-completed:${EFD_JOB}`])).rows[0];
  assert.equal(n.title, "Consulta de EFD concluída.");
  assert.match(n.message, /processada com malha/);
  assert.equal(n.link, "/efd?competence=2026-08");
  await db.query("update public.automation_jobs set status = 'failed', locked_by = null where id = $1", [EFD_JOB]);
  await db.query("update public.automation_tasks set status = 'failed' where job_id = $1", [EFD_JOB]);
  await as(OPERATOR, (tx) => tx.query("select public.retry_automation_job($1)", [EFD_JOB]));
  const t = (await db.query("select status from public.automation_tasks where job_id = $1", [EFD_JOB])).rows[0];
  assert.equal(t.status, "pending");
});

await test("excluir cliente: só admin, só sem histórico, só do próprio escritório, com auditoria", async () => {
  const errado = (
    await as(ADMIN, (tx) =>
      tx.query("insert into public.clients (legal_name, cnpj) values ('CADASTRADO POR ENGANO', '45723174000110') returning id, client_code"),
    )
  ).rows[0];
  await as(ADMIN, (tx) =>
    tx.query(
      "insert into public.certificates (client_id, type, subject_name, valid_until) values ($1, 'A1', 'ENGANO', now() + interval '1 year')",
      [errado.id],
    ),
  );
  // operador e visualizador não excluem
  await rejects(as(OPERATOR, (tx) => tx.query("select public.delete_client($1)", [errado.id])), /FORBIDDEN/);
  await rejects(as(VIEWER, (tx) => tx.query("select public.delete_client($1)", [errado.id])), /FORBIDDEN/);
  // admin de outro escritório não enxerga
  await rejects(as(ADMIN_B, (tx) => tx.query("select public.delete_client($1)", [errado.id])), /CLIENT_NOT_FOUND/);
  // cliente com agendamento: bloqueado (o histórico não some)
  await rejects(as(ADMIN, (tx) => tx.query("select public.delete_client($1)", [CLIENT_A])), /HAS_HISTORY/);
  // sem histórico: sai, com o certificado do painel, e fica na auditoria
  await as(ADMIN, (tx) => tx.query("select public.delete_client($1)", [errado.id]));
  const left = (await db.query("select (select count(*)::int from public.clients where id = $1) c, (select count(*)::int from public.certificates where client_id = $1) k", [errado.id])).rows[0];
  assert.deepEqual(left, { c: 0, k: 0 });
  const audit = (await db.query("select data, org_id from public.audit_logs where action = 'client.deleted' and entity_id = $1", [errado.id])).rows[0];
  assert.equal(audit.data.client_code, errado.client_code);
  assert.equal(audit.data.cnpj, "45723174000110");
  assert.equal(audit.org_id, ORG_A);
});

// ---------------------------------------------------------------------
// Consulta de Malhas Fiscais (SIAT web)
// ---------------------------------------------------------------------
let MALHA_JOB;
await test("Malhas: operador pede a consulta; visualizador não; pedido repetido é ignorado", async () => {
  await rejects(as(VIEWER, (tx) => tx.query("select public.create_malha_check_jobs($1)", [[CLIENT_A]])), /FORBIDDEN/);
  const first = (await as(OPERATOR, (tx) => tx.query("select public.create_malha_check_jobs($1) r", [[CLIENT_A]]))).rows[0].r;
  assert.equal(first.created, 1);
  MALHA_JOB = first.results[0].job_id;
  const job = (await db.query("select operations, status, org_id, competence from public.automation_jobs where id = $1", [MALHA_JOB])).rows[0];
  assert.equal(job.status, "queued");
  assert.equal(job.org_id, ORG_A);
  assert.match(String(job.operations), /MALHA_CHECK/);
  assert.match(job.competence, /^\d{4}-\d{2}$/);
  const tasks = (await db.query("select task_type, operation_type, dedup_key from public.automation_tasks where job_id = $1", [MALHA_JOB])).rows;
  assert.deepEqual(tasks, [{ task_type: "MALHA_CHECK", operation_type: "MALHA", dedup_key: null }]);
  const again = (await as(OPERATOR, (tx) => tx.query("select public.create_malha_check_jobs($1) r", [[CLIENT_A]]))).rows[0].r;
  assert.deepEqual([again.created, again.skipped], [0, 1]);
  await rejects(as(ADMIN_B, (tx) => tx.query("select public.create_malha_check_jobs($1)", [[CLIENT_A]])), /CLIENT_NOT_FOUND|FORBIDDEN/);
});

await test("Malhas: só robô 1.2.19+ pega a consulta; a de EFD continua com o 1.2.0", async () => {
  await db.query("update public.automation_jobs set status = 'cancelled' where org_id = $1 and status = 'queued' and id <> $2", [ORG_A, MALHA_JOB]);
  await db.query("update public.automation_jobs set locked_by = null, locked_at = null");
  await as(DEVICE_A.authId, (tx) =>
    tx.query(`insert into public.worker_heartbeats (worker_id, kind, meta) values ('PC-A-1219', 'all', '{"version":"1.2.19"}')
      on conflict (worker_id) do update set meta = excluded.meta`),
  );
  const efdOnly = await as(DEVICE_A.authId, (tx) => tx.query("select id from public.claim_next_job('PC-A-NOVO')"));
  assert.equal(efdOnly.rows.length, 0, "robô 1.2.0 não deve pegar consulta de malhas");
  const fresh = await as(DEVICE_A.authId, (tx) => tx.query("select id from public.claim_next_job('PC-A-1219')"));
  assert.equal(fresh.rows[0].id, MALHA_JOB);
});

await test("Malhas: uma foto por cliente (upsert), só o próprio escritório lê; conclusão avisa e leva à tela", async () => {
  const sql = `insert into public.malha_checks (client_id, job_id, state_registration, legal_name, findings, total, icms_total, nfe_total)
               values ($1, $2, '197381820', 'CONSULT RL', $3, 1, 110.07, 13)
               on conflict (org_id, client_id) do update set findings = excluded.findings, total = excluded.total, icms_total = excluded.icms_total, checked_at = now()
               returning org_id, total`;
  const one = JSON.stringify([{ source: "EFD_OIE", identification: "[EFD][NFe] Entradas Não Registradas", periods: 1, icms: 110.07, nfe_count: 13, raw: "" }]);
  const r1 = await as(DEVICE_A.authId, (tx) => tx.query(sql, [CLIENT_A, MALHA_JOB, one]));
  assert.equal(r1.rows[0].org_id, ORG_A);
  const r2 = await as(DEVICE_A.authId, (tx) => tx.query(sql, [CLIENT_A, MALHA_JOB, one]));
  assert.equal(r2.rows.length, 1);
  const n = (await db.query("select count(*)::int n from public.malha_checks where client_id = $1", [CLIENT_A])).rows[0].n;
  assert.equal(n, 1);
  const mine = await as(OPERATOR, (tx) => tx.query("select total from public.malha_checks"));
  assert.deepEqual(mine.rows, [{ total: 1 }]);
  const other = await as(ADMIN_B, (tx) => tx.query("select count(*)::int n from public.malha_checks"));
  assert.equal(other.rows[0].n, 0);
  await rejects(as(ADMIN, (tx) => tx.query("insert into public.malha_checks (client_id) values ($1)", [CLIENT_A])), /row-level security/);
  await db.query("update public.automation_jobs set status = 'completed', last_message = 'Malhas fiscais: 1 malha em aberto (EFD/OIE)' where id = $1", [MALHA_JOB]);
  const note = (await db.query("select title, link from public.notifications where dedup_key = $1 limit 1", [`job-completed:${MALHA_JOB}`])).rows[0];
  assert.deepEqual(note, { title: "Consulta de malhas concluída.", link: "/malhas" });
});

await test("repasse: computador sem o certificado devolve o trabalho para outro do escritório", async () => {
  await db.query("update public.automation_jobs set status = 'cancelled' where org_id = $1 and status in ('queued', 'waiting_sefaz')", [ORG_A]);
  await db.query("update public.automation_jobs set locked_by = null, locked_at = null");
  await as(OPERATOR, (tx) => tx.query("select public.create_malha_check_jobs(array[$1]::uuid[])", [CLIENT_A]));
  const JOB = (await db.query("select id from public.automation_jobs where org_id = $1 and status = 'queued' order by created_at desc limit 1", [ORG_A])).rows[0].id;
  await db.query("delete from public.worker_heartbeats");
  await as(DEVICE_A.authId, (tx) =>
    tx.query(`insert into public.worker_heartbeats (worker_id, kind, hostname, meta) values
      ('ALEX-111', 'all', 'ALEX', '{"version":"1.2.25"}'), ('ALEX-999', 'all', 'ALEX', '{"version":"1.2.25"}'),
      ('ESCRITORIO-222', 'all', 'ESCRITORIO', '{"version":"1.2.25"}')`),
  );

  // Alex pega, não tem o certificado e repassa (sem contar tentativa)
  const got = await as(DEVICE_A.authId, (tx) => tx.query("select id from public.claim_next_job('ALEX-111')"));
  assert.equal(got.rows[0].id, JOB);
  const h1 = await as(DEVICE_A.authId, (tx) => tx.query("select public.hand_over_job($1, 'ALEX-111') as r", [JOB]));
  assert.deepEqual(h1.rows[0].r, { handed_over: true, tried: ["ALEX"], waiting_for: ["ESCRITORIO"] });
  const row = (await db.query("select status, locked_by, attempts, skip_hosts from public.automation_jobs where id = $1", [JOB])).rows[0];
  assert.deepEqual(row, { status: "queued", locked_by: null, attempts: 0, skip_hosts: ["ALEX"] });

  // Alex (mesmo reiniciado, outro pid) não pega de novo; o outro computador pega
  const again = await as(DEVICE_A.authId, (tx) => tx.query("select id from public.claim_next_job('ALEX-999')"));
  assert.equal(again.rows.length, 0, "o computador sem o certificado não pode pegar o trabalho de novo");
  const other = await as(DEVICE_A.authId, (tx) => tx.query("select id from public.claim_next_job('ESCRITORIO-222')"));
  assert.equal(other.rows[0].id, JOB);

  // o outro também não tem: não sobrou ninguém -> só anota quem tentou (o robô marca "certificado necessário")
  const h2 = await as(DEVICE_A.authId, (tx) => tx.query("select public.hand_over_job($1, 'ESCRITORIO-222') as r", [JOB]));
  assert.deepEqual(h2.rows[0].r, { handed_over: false, tried: ["ALEX", "ESCRITORIO"], waiting_for: [] });

  // só quem está com o trabalho repassa; robô de B nunca mexe no trabalho de A
  await rejects(as(DEVICE_A.authId, (tx) => tx.query("select public.hand_over_job($1, 'ALEX-111')", [JOB])), /INVALID_STATE/);
  await rejects(as(DEVICE_B.authId, (tx) => tx.query("select public.hand_over_job($1, 'ESCRITORIO-222')", [JOB])), /FORBIDDEN/);
  await rejects(as(OPERATOR, (tx) => tx.query("select public.hand_over_job($1, 'ESCRITORIO-222')", [JOB])), /FORBIDDEN/);

  // coleta: volta a aguardar a SEFAZ, sem contar consulta, e o computador sem o certificado não consulta
  await db.query(
    "update public.automation_jobs set status = 'waiting_sefaz', locked_by = null, skip_hosts = '{}', next_check_at = now(), check_count = 3 where id = $1",
    [JOB],
  );
  const c1 = await as(DEVICE_A.authId, (tx) => tx.query("select id, check_count from public.claim_next_collection('ALEX-111')"));
  assert.deepEqual(c1.rows[0], { id: JOB, check_count: 4 });
  const h3 = await as(DEVICE_A.authId, (tx) => tx.query("select public.hand_over_job($1, 'ALEX-111', true) as r", [JOB]));
  assert.equal(h3.rows[0].r.handed_over, true);
  const coll = (await db.query("select status, check_count, locked_by from public.automation_jobs where id = $1", [JOB])).rows[0];
  assert.deepEqual(coll, { status: "waiting_sefaz", check_count: 3, locked_by: null });
  assert.equal((await as(DEVICE_A.authId, (tx) => tx.query("select id from public.claim_next_collection('ALEX-999')"))).rows.length, 0);
  assert.equal((await as(DEVICE_A.authId, (tx) => tx.query("select id from public.claim_next_collection('ESCRITORIO-222')"))).rows[0].id, JOB);

  // Reprocessar (depois de instalar o certificado) zera a lista
  await db.query("update public.automation_jobs set status = 'certificate_required', locked_by = null, skip_hosts = '{ALEX,ESCRITORIO}' where id = $1", [JOB]);
  await as(OPERATOR, (tx) => tx.query("select public.retry_automation_job($1)", [JOB]));
  const reset = (await db.query("select status, skip_hosts from public.automation_jobs where id = $1", [JOB])).rows[0];
  assert.deepEqual(reset, { status: "queued", skip_hosts: [] });
});

await test("saúde da plataforma: só o dono vê números; robô parado, desatualizado, falhas e parados viram aviso sem repetir", async () => {
  await rejects(as(ADMIN_B, (tx) => tx.query("select * from public.platform_health()")), /FORBIDDEN/);
  await rejects(as(OPERATOR, (tx) => tx.query("select * from public.platform_health()")), /FORBIDDEN/);
  await rejects(as(ADMIN, (tx) => tx.query("select * from public.platform_health_data()")), /permission denied/);
  await rejects(as(ADMIN, (tx) => tx.query("select public.generate_platform_alerts()")), /permission denied/);

  // B no 1.2.25 (lançado há 5 dias) e ligado; A no 1.2.23, sem sinal há 3 h, mas ligado ontem
  await db.query("update public.devices set status = 'active', revoked_at = null where id in ($1, $2)", [DEVICE_A.deviceId, DEVICE_B.deviceId]);
  await db.query("update public.organizations set status = 'active' where id in ($1, $2)", [ORG_A, ORG_B]);
  await db.query("update public.devices set robot_version = '1.2.25', last_seen_at = now() where id = $1", [DEVICE_B.deviceId]);
  await db.query("update public.devices set robot_version = '1.2.23', last_seen_at = now() - interval '3 hours' where id = $1", [DEVICE_A.deviceId]);
  await db.query(
    "insert into public.worker_heartbeats (worker_id, kind, hostname, meta, started_at, last_seen_at) values ('PC-B-1', 'all', 'PC-B', '{\"version\":\"1.2.25\"}', now() - interval '5 days', now())",
  );
  await db.query("update public.app_settings set value = '1' where key = 'health_failures_day'");
  const jobsA = (await db.query("select id from public.automation_jobs where org_id = $1 order by created_at limit 2", [ORG_A])).rows.map((r) => r.id);
  await db.query(
    "update public.automation_jobs set status = 'failed', error_code = 'SCHEDULE_FAILED', finished_at = now(), created_at = now() where id = $1",
    [jobsA[0]],
  );
  await db.query(
    "update public.automation_jobs set status = 'waiting_sefaz', started_at = now() - interval '8 hours', created_at = now(), locked_by = null where id = $1",
    [jobsA[1]],
  );

  const rows = (await as(ADMIN, (tx) => tx.query("select * from public.platform_health()"))).rows;
  const a = rows.find((r) => r.org_id === ORG_A);
  const b = rows.find((r) => r.org_id === ORG_B);
  assert.equal(a.latest_version, "1.2.25");
  assert.deepEqual(
    a.robots.map((x) => [x.name, x.version, x.outdated]),
    [["PC-ESCRITORIO-A", "1.2.23", true]],
  );
  assert.deepEqual(b.robots.map((x) => x.outdated), [false]);
  assert.ok(Number(a.hours_since_signal) >= 2.9);
  assert.equal(a.failed_today, 1);
  assert.equal(a.stuck, 1);
  assert.deepEqual(a.failures_by_code, { SCHEDULE_FAILED: 1 });
  assert.equal(Number(a.limits.failures_day), 1);
  // só números: nenhuma coluna com cliente, CNPJ, nota ou mensagem de trabalho
  assert.ok(!Object.keys(a).some((k) => /cnpj|client_id|legal|note|message|file/.test(k)));

  // quarta-feira, 10h no Piauí: robô parado + desatualizado + falhas + parados para o dono
  const weekday = "2026-09-30 13:00:00+00";
  const created = (await db.query("select public.generate_platform_alerts($1) n", [weekday])).rows[0].n;
  assert.equal(created, 4);
  const again = (await db.query("select public.generate_platform_alerts($1) n", [weekday])).rows[0].n;
  assert.equal(again, 0, "o mesmo aviso não se repete");
  const titles = (
    await as(ADMIN, (tx) => tx.query("select title from public.notifications where dedup_key like 'health:%' order by title"))
  ).rows.map((r) => r.title);
  assert.equal(titles.length, 4);
  assert.deepEqual(
    titles.map((t) => t.split(": ")[0]),
    ["Falhas no robô", "Robô desatualizado", "Robô parado", "Trabalhos parados"],
  );
  assert.ok(titles.every((t) => t.endsWith(`: ${a.name}`)), "todos os avisos são do escritório A");
  const others = (await as(ADMIN_B, (tx) => tx.query("select count(*)::int n from public.notifications where dedup_key like 'health:%'"))).rows[0].n;
  assert.equal(others, 0, "só o dono da plataforma recebe");

  // sábado: PC desligado é normal, sem aviso de robô parado
  const saturday = "2026-10-03 13:00:00+00";
  await db.query("select public.generate_platform_alerts($1)", [saturday]);
  const offline = (await db.query("select count(*)::int n from public.notifications where dedup_key like 'health:offline:%'")).rows[0].n;
  assert.equal(offline, 1);
  await db.query("update public.app_settings set value = '5' where key = 'health_failures_day'");
});

await test("canceladas: pedido próprio, respeita o cadastro, duplicidade separada e Reprocessar", async () => {
  // B não usa NFC-e: as NFC-e canceladas também ficam de fora
  const res = await as(OPERATOR, (tx) =>
    tx.query(
      "select public.create_automation_jobs_batch($1, '2026-06', '{NFE_ISSUED_EXPORT,NFCE_CANCELED_EXPORT,NFE_ISSUED_CANCELED_EXPORT}') r",
      [[CLIENT_B]],
    ),
  );
  const [r] = res.rows[0].r;
  assert.deepEqual(r.operations, ["NFE_ISSUED_EXPORT", "NFE_ISSUED_CANCELED_EXPORT"]);
  const tasks = (
    await db.query("select task_type, document_type, dedup_key from public.automation_tasks where job_id = $1 order by task_type", [r.job_id])
  ).rows;
  assert.deepEqual(
    tasks.map((t) => [t.task_type, t.document_type]),
    [
      ["NFE_ISSUED_EXPORT", "NFE_EMITIDAS"],
      ["NFE_ISSUED_CANCELED_EXPORT", "NFE_EMITIDAS_CANCELADAS"],
    ],
  );
  assert.equal(tasks[1].dedup_key, `${CLIENT_B}|2026-06|NFE_EMITIDAS_CANCELADAS|EXPORT`);
  // pedir as canceladas de novo: já agendadas; pedir só as emitidas normais: também (chaves separadas)
  const again = await as(OPERATOR, (tx) =>
    tx.query("select public.create_automation_job($1, '2026-06', '{NFE_ISSUED_CANCELED_EXPORT}') r", [CLIENT_B]),
  );
  assert.equal(again.rows[0].r.duplicate, true);

  // Reprocessar refaz também o pedido de canceladas
  await db.query("update public.automation_jobs set status = 'failed' where id = $1", [r.job_id]);
  await db.query("update public.automation_tasks set status = 'failed' where job_id = $1", [r.job_id]);
  await as(OPERATOR, (tx) => tx.query("select public.retry_automation_job($1)", [r.job_id]));
  const after = (await db.query("select task_type, status from public.automation_tasks where job_id = $1 order by task_type", [r.job_id])).rows;
  assert.deepEqual(after.map((t) => t.status), ["pending", "pending"]);

  // canceladas sem nota não viram linha "sem movimento" na tela Downloads
  await db.query(
    "update public.automation_tasks set status = 'completed', result = '{\"no_notes\": true}', finished_at = now() where job_id = $1",
    [r.job_id],
  );
  const empty = await as(ADMIN, (tx) =>
    tx.query("select document_type from public.downloads_no_movement where client_id = $1 and competence = '2026-06'", [CLIENT_B]),
  );
  assert.deepEqual(empty.rows.map((x) => x.document_type), ["NFE_EMITIDAS"]);
});

await test("notas: índice gravado pelo robô, lido só pelo escritório, XML pedido pelo painel", async () => {
  const KEY = "22260837354860000133552260000000031820244645";
  const dl = (
    await db.query(
      "insert into public.downloads (client_id, document_type, competence, filename, filepath, checksum) values ($1, 'NFE_EMITIDAS', '2026-08', 'n.zip', 'C:/n.zip', repeat('c', 64)) returning id",
      [CLIENT_B1],
    )
  ).rows[0].id;
  // o robô grava (upsert pela chave) e o escritório é preenchido pelo trigger
  const ins = await as(DEVICE_B.authId, (tx) =>
    tx.query(
      "insert into public.notes (client_id, download_id, document_type, competence, chave, numero, zip_path, xml_name) values ($1, $2, 'NFE_EMITIDAS', '2026-08', $3, 3, 'C:/n.zip', $4) on conflict (client_id, document_type, chave) do update set download_id = excluded.download_id returning org_id",
      [CLIENT_B1, dl, KEY, `${KEY}.xml`],
    ),
  );
  assert.equal(ins.rows[0].org_id, ORG_B);
  // escritório B vê; escritório A não
  const seenB = await as(ADMIN_B, (tx) => tx.query("select numero from public.notes where chave = $1", [KEY]));
  assert.equal(Number(seenB.rows[0].numero), 3);
  const seenA = await as(ADMIN, (tx) => tx.query("select 1 from public.notes where chave = $1", [KEY]));
  assert.equal(seenA.rows.length, 0);
  // pedir o XML: só o próprio escritório consegue; o robô recebe o pedido
  const foreign = await as(ADMIN, (tx) =>
    tx.query("select public.request_note_xml((select id from public.notes where chave = $1)) ok", [KEY]),
  );
  assert.equal(foreign.rows[0].ok, false);
  const mine = await as(ADMIN_B, (tx) =>
    tx.query("select public.request_note_xml((select id from public.notes where chave = $1)) ok", [KEY]),
  );
  assert.equal(mine.rows[0].ok, true);
  const pending = await as(DEVICE_B.authId, (tx) =>
    tx.query("select id from public.notes where xml_requested_at is not null and xml is null and xml_error is null"),
  );
  assert.equal(pending.rows.length, 1);
  await as(DEVICE_B.authId, (tx) => tx.query("update public.notes set xml = '<x/>', xml_at = now() where chave = $1", [KEY]));
  // a limpeza automática apaga o download; o índice fica, apontando para o ZIP
  await db.query("delete from public.downloads where id = $1", [dl]);
  const kept = (await db.query("select download_id, zip_path, xml from public.notes where chave = $1", [KEY])).rows[0];
  assert.equal(kept.download_id, null);
  assert.equal(kept.zip_path, "C:/n.zip");
  assert.equal(kept.xml, "<x/>");
});

await test("nota pela chave: pedido do painel vira trabalho do robô; só robôs 1.2.34+ pegam; emitente decide o tipo", async () => {
  const ASSAI = "22260806057223046163553000001722801561303961"; // emitente de fora: nota recebida
  // operador do escritório B pede a nota com o certificado do cliente B1
  const r1 = (await as(ADMIN_B, (tx) => tx.query("select public.request_note_from_siat($1, $2) r", [CLIENT_B1, ASSAI]))).rows[0].r;
  assert.ok(r1.job_id);
  assert.equal(r1.document_type, "NFE_RECEBIDAS");
  assert.equal(r1.competence, "2026-08");
  const job = (await db.query("select note_key, competence, operations, status, org_id from public.automation_jobs where id = $1", [r1.job_id])).rows[0];
  assert.equal(job.note_key, ASSAI);
  assert.deepEqual([job.competence, job.status, job.org_id], ["2026-08", "queued", ORG_B]);
  assert.match(String(job.operations), /NFE_KEY_EXPORT/); // PGlite devolve o array de enum como texto
  const task = (await db.query("select task_type, document_type, dedup_key from public.automation_tasks where job_id = $1", [r1.job_id])).rows[0];
  assert.equal(task.task_type, "NFE_KEY_EXPORT");
  assert.equal(task.document_type, "NFE_RECEBIDAS");
  assert.ok(task.dedup_key.endsWith(`|KEY:${ASSAI}`));
  // pedir de novo enquanto está em andamento: devolve o mesmo trabalho
  const r2 = (await as(ADMIN_B, (tx) => tx.query("select public.request_note_from_siat($1, $2) r", [CLIENT_B1, ASSAI]))).rows[0].r;
  assert.deepEqual([r2.job_id, r2.duplicate], [r1.job_id, true]);
  // chave curta, NFC-e e cliente de outro escritório: recusados
  await rejects(as(ADMIN_B, (tx) => tx.query("select public.request_note_from_siat($1, '123')", [CLIENT_B1])), /INVALID_KEY/);
  await rejects(
    as(ADMIN_B, (tx) => tx.query("select public.request_note_from_siat($1, $2)", [CLIENT_B1, ASSAI.slice(0, 20) + "65" + ASSAI.slice(22)])),
    /INVALID_KEY/,
  );
  await rejects(as(ADMIN, (tx) => tx.query("select public.request_note_from_siat($1, $2)", [CLIENT_B1, ASSAI])), /FORBIDDEN|CLIENT/);
  // fila: robô 1.2.33 não pega; 1.2.34 pega
  await as(DEVICE_B.authId, (tx) =>
    tx.query(`insert into public.worker_heartbeats (worker_id, kind, meta) values
      ('PC-B-1233', 'all', '{"version":"1.2.33"}'), ('PC-B-1234', 'all', '{"version":"1.2.34"}')`),
  );
  const old = await as(DEVICE_B.authId, (tx) => tx.query("select id from public.claim_next_job('PC-B-1233')"));
  assert.ok(!old.rows.some((r) => r.id === r1.job_id), "robô antigo não pode pegar a nota pela chave");
  const fresh = await as(DEVICE_B.authId, (tx) => tx.query("select id, note_key from public.claim_next_job('PC-B-1234')"));
  assert.equal(fresh.rows[0]?.id, r1.job_id);
  assert.equal(fresh.rows[0]?.note_key, ASSAI);
  // o robô grava o ZIP da nota (fora da tela Downloads) e, ao concluir, o aviso aponta para a tela Notas
  await as(DEVICE_B.authId, (tx) =>
    tx.query(
      "insert into public.downloads (client_id, job_id, document_type, competence, filename, filepath, checksum, note_key) values ($1, $2, 'NFE_RECEBIDAS', '2026-08', 'NFe.zip', 'C:/NFe.zip', repeat('d', 64), $3)",
      [CLIENT_B1, r1.job_id, ASSAI],
    ),
  );
  await db.query("update public.automation_jobs set status = 'completed', last_message = 'Nota exportada' where id = $1", [r1.job_id]);
  const notice = (await db.query("select title, link from public.notifications where dedup_key = $1", ["job-completed:" + r1.job_id])).rows[0];
  assert.equal(notice.title, "Nota encontrada no SIAT.");
  assert.equal(notice.link, "/notes?q=" + ASSAI);
  // já indexada: não cria trabalho novo
  await as(DEVICE_B.authId, (tx) =>
    tx.query(
      "insert into public.notes (client_id, document_type, competence, chave, numero, zip_path, xml_name) values ($1, 'NFE_RECEBIDAS', '2026-08', $2, 172280, 'C:/NFe.zip', $3)",
      [CLIENT_B1, ASSAI, `${ASSAI}.xml`],
    ),
  );
  const r3 = (await as(ADMIN_B, (tx) => tx.query("select public.request_note_from_siat($1, $2) r", [CLIENT_B1, ASSAI]))).rows[0].r;
  assert.equal(r3.already_indexed, true);
  assert.ok(r3.note_id);
  // emitente é o próprio cliente: nota emitida
  const cnpjB1 = (await db.query("select regexp_replace(cnpj, '\\D', '', 'g') c from public.clients where id = $1", [CLIENT_B1])).rows[0].c;
  const first43 = "2226" + "08" + cnpjB1 + "55" + "001" + "000000777" + "1" + "12345678";
  let sum = 0, w = 2;
  for (let i = first43.length - 1; i >= 0; i--) { sum += Number(first43[i]) * w; w = w === 9 ? 2 : w + 1; }
  const dv = 11 - (sum % 11);
  const issued = first43 + String(dv >= 10 ? 0 : dv);
  const r4 = (await as(ADMIN_B, (tx) => tx.query("select public.request_note_from_siat($1, $2) r", [CLIENT_B1, issued]))).rows[0].r;
  assert.equal(r4.document_type, "NFE_EMITIDAS");
});

await test("operação do dia: cada escritório vê só os próprios trabalhos; o dono vê números de todos", async () => {
  const from = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const to = new Date(Date.now() + 3_600_000).toISOString();
  // escritório B: só os próprios trabalhos e robôs; sem resumo de escritórios
  const b = (await as(ADMIN_B, (tx) => tx.query("select public.operation_report($1, $2) r", [from, to]))).rows[0].r;
  assert.equal(b.owner, false);
  assert.equal(b.offices, null);
  assert.ok(b.jobs.length > 0, "o escritório B tem trabalhos nos testes anteriores");
  const ids = b.jobs.map((j) => j.id);
  const orgs = (await db.query("select distinct org_id from public.automation_jobs where id = any($1::uuid[])", [ids])).rows;
  assert.deepEqual(orgs.map((r) => r.org_id), [ORG_B]);
  assert.ok(b.sessions.every((x) => x.org_id === ORG_B));
  // dono (escritório A): os próprios trabalhos com nome de cliente; dos outros, só números
  const a = (await as(ADMIN, (tx) => tx.query("select public.operation_report($1, $2) r", [from, to]))).rows[0].r;
  assert.equal(a.owner, true);
  const aOrgs = (await db.query("select distinct org_id from public.automation_jobs where id = any($1::uuid[])", [a.jobs.map((j) => j.id)])).rows;
  assert.ok(aOrgs.every((r) => r.org_id === ORG_A), "nenhum trabalho de outro escritório na lista do dono");
  const officeB = a.offices.find((o) => o.id === ORG_B);
  assert.ok(officeB && typeof officeB.clients === "number" && officeB.own === false);
  assert.ok(!JSON.stringify(a.offices).includes("CLI"), "resumo sem códigos de cliente");
  // eventos de outro escritório: só quantidades (sem nome de cliente nem e-mail)
  const foreign = a.events.filter((e) => !e.own);
  assert.ok(foreign.every((e) => !/CLI\d|@/.test(e.text)));
  // período inválido
  await rejects(as(ADMIN, (tx) => tx.query("select public.operation_report($1, $2)", [to, from])), /INVALID_PERIOD/);
  await rejects(as("anon", (tx) => tx.query("select public.operation_report($1, $2)", [from, to])), /permission denied/);
});

await test("NFS-e: painel pede a busca; só robôs 1.2.36+ pegam; último NSU e índice com chave de 50 números", async () => {
  // operador pede; visualizador não; pedido repetido enquanto está na fila é ignorado
  const r1 = (await as(ADMIN_B, (tx) => tx.query("select public.create_nfse_fetch_jobs($1::uuid[], '2026-09') r", [[CLIENT_B1]]))).rows[0].r;
  assert.equal(r1.created, 1);
  const jobId = r1.results[0].job_id;
  const job = (await db.query("select operations, status, org_id, competence from public.automation_jobs where id = $1", [jobId])).rows[0];
  assert.match(String(job.operations), /NFSE_FETCH/);
  assert.deepEqual([job.status, job.org_id, job.competence], ["queued", ORG_B, "2026-09"]);
  const task = (await db.query("select task_type, status from public.automation_tasks where job_id = $1", [jobId])).rows[0];
  assert.deepEqual([task.task_type, task.status], ["NFSE_FETCH", "pending"]);
  const again = (await as(ADMIN_B, (tx) => tx.query("select public.create_nfse_fetch_jobs($1::uuid[], '2026-10') r", [[CLIENT_B1]]))).rows[0].r;
  assert.deepEqual([again.created, again.skipped], [0, 1]);
  await rejects(as(VIEWER, (tx) => tx.query("select public.create_nfse_fetch_jobs($1::uuid[], '2026-09')", [[CLIENT_A]])), /FORBIDDEN/);
  await rejects(as(ADMIN, (tx) => tx.query("select public.create_nfse_fetch_jobs($1::uuid[], '2026-09')", [[CLIENT_B1]])), /FORBIDDEN|CLIENT/);
  // fila: os outros trabalhos de B já foram resolvidos nos testes anteriores; robô 1.2.35 não pega, 1.2.36 pega
  await db.query(
    "update public.automation_jobs set status = 'completed', locked_by = null, locked_at = null where org_id = $1 and id <> $2 and (status = 'queued' or locked_by is not null)",
    [ORG_B, jobId],
  );
  await as(DEVICE_B.authId, (tx) =>
    tx.query(`insert into public.worker_heartbeats (worker_id, kind, meta) values
      ('PC-B-1235', 'all', '{"version":"1.2.35"}'), ('PC-B-1236', 'all', '{"version":"1.2.36"}')`),
  );
  const old = await as(DEVICE_B.authId, (tx) => tx.query("select id from public.claim_next_job('PC-B-1235')"));
  assert.equal(old.rows.length, 0, "robô antigo não pode pegar a busca de NFS-e");
  const fresh = await as(DEVICE_B.authId, (tx) => tx.query("select id from public.claim_next_job('PC-B-1236')"));
  assert.equal(fresh.rows[0]?.id, jobId);
  // o robô guarda o último NSU do cliente (escritório preenchido pelo trigger); A não vê
  const cur = await as(DEVICE_B.authId, (tx) =>
    tx.query(
      "insert into public.nfse_cursors (client_id, last_nsu, fetched_at, last_documents) values ($1, 14, now(), 13) on conflict (client_id) do update set last_nsu = excluded.last_nsu returning org_id",
      [CLIENT_B1],
    ),
  );
  assert.equal(cur.rows[0].org_id, ORG_B);
  await as(DEVICE_B.authId, (tx) => tx.query("update public.nfse_cursors set last_nsu = 51 where client_id = $1", [CLIENT_B1]));
  assert.equal(Number((await as(ADMIN_B, (tx) => tx.query("select last_nsu from public.nfse_cursors"))).rows[0].last_nsu), 51);
  assert.equal((await as(ADMIN, (tx) => tx.query("select 1 from public.nfse_cursors"))).rows.length, 0);
  await rejects(as(DEVICE_B.authId, (tx) => tx.query("update public.nfse_cursors set last_nsu = -1 where client_id = $1", [CLIENT_B1])), /nfse_cursors_nsu_positive/);
  // índice: chave de 50 números (NFS-e) com o ISS; 45 números é recusado
  const NFSE = "22110011211222333000181000000000000226040000000017";
  await as(DEVICE_B.authId, (tx) =>
    tx.query(
      "insert into public.notes (client_id, document_type, competence, chave, numero, valor, iss_retido, iss_valor, municipio, servico, zip_path, xml_name) values ($1, 'NFSE_PRESTADAS', '2026-04', $2, 2, 8900, false, 445, 'Teresina', 'Consultoria', 'C:/s.zip', $3)",
      [CLIENT_B1, NFSE, `NFSe ${NFSE}.xml`],
    ),
  );
  const note = (await as(ADMIN_B, (tx) => tx.query("select document_type, iss_valor, municipio from public.notes where chave = $1", [NFSE]))).rows[0];
  assert.deepEqual([note.document_type, Number(note.iss_valor), note.municipio], ["NFSE_PRESTADAS", 445, "Teresina"]);
  await rejects(
    as(DEVICE_B.authId, (tx) =>
      tx.query(
        "insert into public.notes (client_id, document_type, competence, chave, zip_path, xml_name) values ($1, 'NFSE_TOMADAS', '2026-04', $2, 'C:/s.zip', 'x.xml')",
        [CLIENT_B1, NFSE + "1"],
      ),
    ),
    /notes_chave_format/,
  );
  // conclusão com nota nova avisa e leva à tela NFS-e (um aviso só por lote de 10 minutos)
  await db.query("update public.automation_jobs set status = 'completed', last_message = 'NFS-e: 2 tomada(s) nova(s).' where id = $1", [jobId]);
  const notices = (await db.query("select title, link, message from public.notifications where dedup_key like 'nfse-done:%'")).rows;
  assert.equal(notices.length, 1);
  assert.deepEqual([notices[0].title, notices[0].link], ["Busca de NFS-e: há novidades.", "/nfse"]);
  assert.match(notices[0].message, /2 tomada\(s\) nova\(s\)\. O resultado de cada cliente/);
  // Reprocessar recoloca a busca na fila
  await db.query("update public.automation_jobs set status = 'failed' where id = $1", [jobId]);
  await db.query("update public.automation_tasks set status = 'failed' where job_id = $1", [jobId]);
  await as(ADMIN_B, (tx) => tx.query("select public.retry_automation_job($1)", [jobId]));
  const retried = (await db.query("select status from public.automation_tasks where job_id = $1", [jobId])).rows[0];
  assert.equal(retried.status, "pending");
  // a segunda busca do mesmo lote não repete o aviso; busca sem nota nova não avisa
  await db.query("update public.automation_jobs set status = 'completed', last_message = 'NFS-e: 5 prestada(s) nova(s).' where id = $1", [jobId]);
  assert.equal((await db.query("select 1 from public.notifications where dedup_key like 'nfse-done:%'")).rows.length, 1);
  await db.query("delete from public.notifications where dedup_key like 'nfse-done:%'");
  await db.query("update public.automation_jobs set status = 'failed' where id = $1", [jobId]);
  await db.query("update public.automation_jobs set status = 'completed', last_message = 'NFS-e: nenhuma nota nova.' where id = $1", [jobId]);
  assert.equal((await db.query("select 1 from public.notifications where dedup_key like 'nfse-done:%'")).rows.length, 0);
});

await test("empresa só de serviço (sem SIAT): fica fora dos pedidos do SIAT, mas a NFS-e continua", async () => {
  // desligar o SIAT desliga as três marcações de nota
  const off = (
    await as(ADMIN_B, (tx) =>
      tx.query("update public.clients set uses_siat = false where id = $1 returning uses_nfce, uses_nfe_issued, uses_nfe_received", [CLIENT_B1]),
    )
  ).rows[0];
  assert.deepEqual([off.uses_nfce, off.uses_nfe_issued, off.uses_nfe_received], [false, false, false]);
  // agendamento do mês: sem operação habilitada; mesmo ignorando o cadastro, o banco recusa
  const batch = (
    await as(ADMIN_B, (tx) =>
      tx.query("select public.create_automation_jobs_batch($1::uuid[], '2026-06', array['NFCE_EXPORT']::public.task_type[], false, true) r", [[CLIENT_B1]]),
    )
  ).rows[0].r;
  assert.equal(batch[0].error, "NO_OPERATIONS");
  const forced = (
    await as(ADMIN_B, (tx) =>
      tx.query("select public.create_automation_jobs_batch($1::uuid[], '2026-06', array['NFCE_EXPORT']::public.task_type[], false, false) r", [[CLIENT_B1]]),
    )
  ).rows[0].r;
  assert.equal(forced[0].job_id, null);
  assert.match(forced[0].message, /NO_SIAT/);
  // EFD e malhas também não entram
  await rejects(as(ADMIN_B, (tx) => tx.query("select public.create_efd_check_jobs($1::uuid[], '2026-06')", [[CLIENT_B1]])), /NO_SIAT/);
  await rejects(as(ADMIN_B, (tx) => tx.query("select public.create_malha_check_jobs($1::uuid[])", [[CLIENT_B1]])), /NO_SIAT/);
  assert.equal((await db.query("select 1 from public.automation_jobs where client_id = $1 and competence = '2026-06'", [CLIENT_B1])).rows.length, 0);
  // a busca de NFS-e continua valendo
  await db.query("update public.automation_jobs set status = 'completed' where client_id = $1 and status not in ('completed', 'failed', 'cancelled')", [CLIENT_B1]);
  const nfse = (await as(ADMIN_B, (tx) => tx.query("select public.create_nfse_fetch_jobs($1::uuid[], '2026-06') r", [[CLIENT_B1]]))).rows[0].r;
  assert.equal(nfse.created, 1);
  // voltar a usar o SIAT: as marcações são religadas no cadastro, não sozinhas
  const on = (await as(ADMIN_B, (tx) => tx.query("update public.clients set uses_siat = true, uses_nfce = true where id = $1 returning uses_nfce, uses_nfe_issued", [CLIENT_B1]))).rows[0];
  assert.deepEqual([on.uses_nfce, on.uses_nfe_issued], [true, false]);
});

console.log(`\n${passed} teste(s) de banco passaram${process.exitCode ? " (com falhas)" : ""}.`);
await db.close();
