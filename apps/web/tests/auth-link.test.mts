// Link do convite / redefinir senha que volta ao painel com a sessão no fim do endereço.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { authLinkTarget, INVITE_PATH, parseAuthHash, passwordErrorMessage } from "../src/lib/auth-link.ts";

describe("link do e-mail de login", () => {
  it("convite: lê a sessão e leva para criar a senha", () => {
    const link = parseAuthHash("#access_token=aaa&expires_at=1&expires_in=3600&refresh_token=rrr&token_type=bearer&type=invite");
    assert.deepEqual(link, { kind: "session", accessToken: "aaa", refreshToken: "rrr", type: "invite" });
    assert.equal(authLinkTarget("invite"), INVITE_PATH);
    assert.equal(INVITE_PATH, "/reset-password?primeiro=1");
  });

  it("redefinir senha e outros tipos", () => {
    assert.equal(authLinkTarget("recovery"), "/reset-password");
    assert.equal(authLinkTarget("magiclink", "/operation"), "/operation");
    assert.equal(authLinkTarget("magiclink", "https://outro.site"), "/dashboard");
  });

  it("link vencido ou já usado vira erro", () => {
    assert.deepEqual(parseAuthHash("#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid"), {
      kind: "error",
      code: "otp_expired",
    });
  });

  it("endereço sem chave não é link de e-mail", () => {
    assert.equal(parseAuthHash(""), null);
    assert.equal(parseAuthHash("#secao"), null);
    assert.equal(parseAuthHash("#access_token=sem-refresh"), null);
  });

  it("erro ao gravar a senha em português", () => {
    assert.match(passwordErrorMessage("Auth session missing!"), /já foi usado ou venceu/);
    assert.equal(passwordErrorMessage("outro erro"), "outro erro");
  });
});
