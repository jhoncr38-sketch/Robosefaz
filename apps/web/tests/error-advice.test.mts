// Histórico: cada código de erro tem uma frase de "o que fazer", em linguagem simples, no lugar do código.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ERROR_ADVICE, ERROR_CODE_LABEL, errorAdvice } from "../src/lib/status.ts";

describe("o que fazer em cada erro", () => {
  it("todo código com rótulo tem uma orientação, e ela não repete o código", () => {
    for (const code of Object.keys(ERROR_CODE_LABEL)) {
      const advice = ERROR_ADVICE[code];
      assert.ok(advice, `sem orientação para ${code}`);
      assert.ok(advice.length >= 30 && !advice.includes(code), code);
    }
  });

  it("os erros de hoje viram instrução", () => {
    assert.match(errorAdvice("SECURITY_CLIENT_MISMATCH") ?? "", /inscrição estadual/);
    assert.match(errorAdvice("CERTIFICATE_EXPIRED") ?? "", /Certificados/);
    assert.equal(errorAdvice("NAO_EXISTE"), null);
    assert.equal(errorAdvice(null), null);
    assert.equal(errorAdvice(undefined), null);
  });
});
