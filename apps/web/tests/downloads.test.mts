// Horário do Piauí (servidor em UTC) e regras da tela Downloads.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { currentCompetence, previousCompetence, recentCompetences } from "../src/lib/competence.ts";
import { bulkTarget, driveDownloadUrl, driveFolderUrl, isEmptyZip, usesGoogleDrive } from "../src/lib/downloads.ts";
import { formatDate, formatDateTime, formatShortAgo, formatTime } from "../src/lib/format.ts";

describe("horário do Piauí", () => {
  it("mostra a hora local, não a do servidor (UTC)", () => {
    // robô salvou às 20:54 em Teresina = 23:54 UTC
    assert.equal(formatDateTime("2026-09-28T23:54:44.640+00:00"), "28/09/2026 20:54");
    assert.equal(formatDateTime("2026-09-29T01:23:21Z"), "28/09/2026 22:23");
    assert.equal(formatTime("2026-09-29T01:23:21Z"), "22:23:21");
    assert.equal(formatDate("2026-09-29T01:23:21Z"), "28/09/2026");
    assert.equal(formatDate("2026-12-31"), "31/12/2026"); // data pura não muda de dia
  });
  it("dia e competência viram no horário do Piauí", () => {
    const now = new Date("2026-10-01T02:00:00Z"); // 30/09 23:00 em Teresina
    assert.equal(currentCompetence(now), "2026-09");
    assert.equal(previousCompetence(now), "2026-08");
    assert.deepEqual(recentCompetences(3, now), ["2026-09", "2026-08", "2026-07"]);
    assert.equal(formatShortAgo("2026-09-30T13:00:00Z", now), "13h"); // mesmo dia em Teresina
    assert.equal(formatShortAgo("2026-09-29T20:00:00Z", now), "ontem");
    assert.equal(formatShortAgo("2026-09-12T12:00:00Z", now), "12/09");
  });
});

describe("tela Downloads", () => {
  it("ZIP vazio (22 bytes) é sem notas", () => {
    assert.equal(isEmptyZip({ filename: "CLI000022_2026-09_NFE_EMITIDAS.zip", size: 22 }), true);
    assert.equal(isEmptyZip({ filename: "CLI000022_2026-09_NFE_RECEBIDAS.zip", size: 74269 }), false);
    assert.equal(isEmptyZip({ filename: "CLI000022_2026-09_NFE_EMITIDAS.xml", size: 20 }), false);
  });
  it("Baixar baixa direto do Google Drive pelo código do arquivo", () => {
    assert.equal(
      driveDownloadUrl("1jIOcup0tsxX4h2TCXGwS0YYtSbGRh33v"),
      "https://drive.google.com/uc?export=download&id=1jIOcup0tsxX4h2TCXGwS0YYtSbGRh33v",
    );
    assert.equal(driveDownloadUrl(null), null); // ainda subindo
    assert.equal(driveDownloadUrl("local-1898"), null);
    assert.equal(driveDownloadUrl("https://evil.example/1jIOcup0tsxX4h2TCXGwS0YYt"), null);
  });
  it("botão Baixar só quando algum robô salva no Google Drive", () => {
    assert.equal(usesGoogleDrive([{ meta: { version: "1.2.5" } }, { meta: null }]), false);
    assert.equal(usesGoogleDrive([{ meta: { notes_folder: "local" } }, { meta: { notes_folder: "google_drive" } }]), true);
  });
  it("Baixar todas: pasta do mês ou do cliente no mês", () => {
    const MONTH = "17sSm4IpL_iXnBG2hyRVQ6Kw_YUUVaCLX";
    const LIA = "1DB4jzRLko3Xm3ZtWdC4235rCAf7v8-Xp";
    const row = (client_id: string, filename: string, size = 5000, ids = true) => ({
      competence: "2026-09",
      client_id,
      filename,
      size,
      drive_client_folder_id: ids ? (client_id === "lia" ? LIA : "1OutraPastaDeClienteNoDrive00000") : null,
      drive_month_folder_id: ids ? MONTH : null,
    });
    const rows = [
      row("lia", "CLI000001_2026-09_NFCE.zip"),
      row("lia", "CLI000001_2026-09_NFE_EMITIDAS.zip"),
      row("bolo", "CLI000022_2026-09_NFE_EMITIDAS.zip", 22), // ZIP vazio não conta
      row("bolo", "CLI000022_2026-09_NFE_RECEBIDAS.zip"),
    ];
    assert.equal(bulkTarget(rows, undefined, undefined), null); // sem competência
    assert.deepEqual(bulkTarget(rows, "2026-09", undefined), {
      kind: "month",
      folderUrl: `https://drive.google.com/drive/folders/${MONTH}`,
      files: 3,
      clients: 2,
    });
    const lia = bulkTarget(rows, "2026-09", "lia");
    assert.equal(lia?.folderUrl, `https://drive.google.com/drive/folders/${LIA}`);
    assert.equal(lia?.files, 2);
    // notas ainda subindo para o Drive: sem link
    assert.equal(bulkTarget([row("lia", "CLI000001_2026-09_NFCE.zip", 5000, false)], "2026-09", "lia")?.folderUrl, null);
    assert.equal(driveFolderUrl("../x"), null);
  });
});
