// Aplica a migration de organizações sobre um banco que JÁ tem dados (como a
// produção): tudo deve ir para o escritório inicial, o dono da plataforma deve
// ser o primeiro admin e os códigos dos clientes devem continuar a sequência.
//
// Uso: cd supabase/tests && node backfill.test.mjs

import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "migrations");
const stubs = readFileSync(join(here, "run-migrations.test.mjs"), "utf8").match(/const SUPABASE_STUBS = `([\s\S]*?)`;/)[1];

const db = new PGlite({ extensions: { pgcrypto } });
await db.exec(stubs);
const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
const orgMigration = files.find((f) => f.includes("organizations"));
for (const file of files.filter((f) => f < orgMigration)) {
  await db.exec(readFileSync(join(migrationsDir, file), "utf8"));
}

// dados "de produção" antes da mudança
const user = async (email, meta = {}) =>
  (await db.query("insert into auth.users (email, raw_app_meta_data) values ($1, $2) returning id", [email, meta])).rows[0].id;
const admin = await user("dono@x.com");
const op = await user("op@x.com", { role: "operator" });
const c1 = (await db.query("insert into public.clients (legal_name, cnpj) values ('A', '11222333000181') returning id")).rows[0].id;
await db.query("insert into public.clients (legal_name, cnpj) values ('B', '11444777000161')");
await db.query("insert into public.certificates (client_id, subject_name, valid_until) values ($1, 'A', now() + interval '1 year')", [c1]);
const job = (await db.query(
  "insert into public.automation_jobs (client_id, created_by, competence, start_date, end_date, operations) values ($1, $2, '2026-08', '2026-08-01', '2026-08-31', '{NFCE_EXPORT}') returning id",
  [c1, admin],
)).rows[0].id;
await db.query("insert into public.automation_tasks (job_id, client_id, task_type, competence) values ($1, $2, 'NFCE_EXPORT', '2026-08')", [job, c1]);
await db.query("insert into public.automation_logs (job_id, message) values ($1, 'log antigo'), (null, 'log sem job')", [job]);
await db.query(
  "insert into public.downloads (client_id, job_id, document_type, competence, filename, filepath, checksum) values ($1, $2, 'NFCE', '2026-08', 'x.zip', 'C:/x.zip', repeat('a', 64))",
  [c1, job],
);
await db.query("insert into public.notifications (user_id, title, message) values ($1, 't', 'm')", [op]);
await db.query("insert into public.worker_heartbeats (worker_id, kind) values ('PC-1', 'all')");

await db.exec(readFileSync(join(migrationsDir, orgMigration), "utf8"));
// migrations posteriores (ex.: computadores) também sobre os dados existentes
for (const file of files.filter((f) => f > orgMigration)) {
  await db.exec(readFileSync(join(migrationsDir, file), "utf8"));
}

const org = (await db.query("select id, name, client_code_seq from public.organizations")).rows;
assert.equal(org.length, 1);
assert.equal(org[0].name, "Escritório Jhonatan Rodrigues");
assert.equal(org[0].client_code_seq, 2, "sequência continua de onde os códigos pararam");
const orgId = org[0].id;

for (const t of ["profiles", "clients", "certificates", "automation_jobs", "automation_tasks", "downloads", "notifications"]) {
  const r = (await db.query(`select count(*)::int total, count(*) filter (where org_id = $1)::int ok from public.${t}`, [orgId])).rows[0];
  assert.equal(r.ok, r.total, `${t}: nem tudo foi para o escritório inicial`);
}
const logs = (await db.query("select message, org_id from public.automation_logs order by id")).rows;
assert.deepEqual(logs.map((l) => [l.message, l.org_id]), [["log antigo", orgId], ["log sem job", null]]);
const audit = (await db.query("select count(*)::int n from public.audit_logs where org_id is distinct from $1", [orgId])).rows[0].n;
assert.equal(audit, 0);
const owner = (await db.query("select email from public.profiles where is_platform_owner")).rows;
assert.deepEqual(owner, [{ email: "dono@x.com" }]);

// novo cliente depois da mudança continua a numeração do escritório
await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: admin, role: "authenticated" })]);
await db.exec("set role authenticated");
const next = (await db.query("insert into public.clients (legal_name, cnpj) values ('C', '04252011000110') returning client_code")).rows[0];
assert.equal(next.client_code, "CLI000003");
const visible = (await db.query("select count(*)::int n from public.clients")).rows[0].n;
assert.equal(visible, 3);
await db.exec("reset role");

console.log("ok  migração sobre dados existentes: tudo no escritório inicial, dono = primeiro admin, códigos continuam");
await db.close();
