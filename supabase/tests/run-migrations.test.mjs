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
const OPERATOR = await newUser("op@x.com", { role: "operator" });
const VIEWER = await newUser("viewer@x.com");
// tentativa de escalonamento via user_metadata (controlado pelo próprio usuário)
await newUser("zz-hacker@x.com", {}, { role: "admin" });

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
  await rejects(as(OPERATOR, (tx) => tx.query("select * from public.claim_next_job('w1')")), /permission denied/);
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

console.log(`\n${passed} teste(s) de banco passaram${process.exitCode ? " (com falhas)" : ""}.`);
await db.close();
