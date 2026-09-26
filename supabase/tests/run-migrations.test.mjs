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
  raw_app_meta_data jsonb default '{}'::jsonb
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

await test("RLS: viewer/operator não cadastram clientes; anon não lê nada", async () => {
  await rejects(
    as(VIEWER, (tx) => tx.query("insert into public.clients (legal_name, cnpj) values ('X', '04252011000110')")),
    /row-level security/,
  );
  await rejects(
    as(OPERATOR, (tx) => tx.query("insert into public.clients (legal_name, cnpj) values ('X', '04252011000110')")),
    /row-level security/,
  );
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

await test("forçar novo agendamento: só admin", async () => {
  await rejects(
    as(OPERATOR, (tx) => tx.query("select public.create_automation_job($1, '2026-08', '{NFCE_EXPORT}', true)", [CLIENT_A])),
    /somente administradores/,
  );
  const res = await as(ADMIN, (tx) =>
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

await test("reprocessar: só admin; job volta para a fila", async () => {
  await db.query("update public.automation_jobs set status = 'failed', locked_by = null where id = $1", [JOB_A]);
  await db.query("update public.automation_tasks set status = 'failed' where job_id = $1", [JOB_A]);
  await rejects(as(OPERATOR, (tx) => tx.query("select public.retry_automation_job($1)", [JOB_A])), /FORBIDDEN/);
  await as(ADMIN, (tx) => tx.query("select public.retry_automation_job($1)", [JOB_A]));
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
  const general = (await db.query("select org_id from public.automation_logs where message = 'mensagem geral do robô'")).rows[0];
  assert.equal(general.org_id, ORG_B);
  const hb = (await db.query("select org_id, device_id from public.worker_heartbeats where worker_id = 'PC-B-1'")).rows[0];
  assert.deepEqual(hb, { org_id: ORG_B, device_id: DEVICE_B.deviceId });
  const dev = (await db.query("select robot_version, last_seen_at is not null seen from public.devices where id = $1", [DEVICE_B.deviceId])).rows[0];
  assert.deepEqual(dev, { robot_version: "1.1.0", seen: true });
  const seenByA = await as(DEVICE_A.authId, (tx) => tx.query("select count(*)::int n from public.worker_heartbeats where worker_id = 'PC-B-1'"));
  assert.equal(seenByA.rows[0].n, 0);
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

console.log(`\n${passed} teste(s) de banco passaram${process.exitCode ? " (com falhas)" : ""}.`);
await db.close();
