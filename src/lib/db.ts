import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

/**
 * SQLite-kerros: säilytetään vain kutsuloki ja eval-tulokset.
 * Kulutuksen ja budjetin totuus säilyy LiteLLM:ssä/OpenRouterissa - tätä ei
 * ryhdytä pitämään ajan tasalla omassa kannassa.
 */
export interface CallLogRow {
  taskType: string;
  modelRequested: string;
  modelUsed: string;
  usedFallback: boolean;
  latencyMs: number;
  status: "ok" | "error";
  errorMessage?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
}

export interface EvalRunRow {
  runId: string;
  promptSetPath: string;
  models: string[];
  judgeUsed: boolean;
}

export interface EvalResultRow {
  runId: string;
  promptId: string;
  model: string;
  latencyMs: number;
  response: string;
  passed: boolean | null;
  judgeScore: number | null;
  priceUsd: number | null;
  errorMessage: string | null;
}

export class Db {
  private db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS call_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        task_type TEXT NOT NULL,
        model_requested TEXT NOT NULL,
        model_used TEXT NOT NULL,
        used_fallback INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        error_message TEXT,
        prompt_tokens INTEGER,
        completion_tokens INTEGER
      );

      CREATE TABLE IF NOT EXISTS eval_run (
        run_id TEXT PRIMARY KEY,
        ts TEXT NOT NULL,
        prompt_set_path TEXT NOT NULL,
        models TEXT NOT NULL,
        judge_used INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS eval_result (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        prompt_id TEXT NOT NULL,
        model TEXT NOT NULL,
        latency_ms INTEGER NOT NULL,
        response TEXT NOT NULL,
        passed INTEGER,
        judge_score REAL,
        price_usd REAL,
        error_message TEXT,
        FOREIGN KEY (run_id) REFERENCES eval_run(run_id)
      );
    `);
  }

  insertCallLog(row: CallLogRow): void {
    this.db
      .prepare(
        `INSERT INTO call_log
          (ts, task_type, model_requested, model_used, used_fallback, latency_ms, status, error_message, prompt_tokens, completion_tokens)
         VALUES (@ts, @taskType, @modelRequested, @modelUsed, @usedFallback, @latencyMs, @status, @errorMessage, @promptTokens, @completionTokens)`,
      )
      .run({
        ts: new Date().toISOString(),
        taskType: row.taskType,
        modelRequested: row.modelRequested,
        modelUsed: row.modelUsed,
        usedFallback: row.usedFallback ? 1 : 0,
        latencyMs: row.latencyMs,
        status: row.status,
        errorMessage: row.errorMessage ?? null,
        promptTokens: row.promptTokens ?? null,
        completionTokens: row.completionTokens ?? null,
      });
  }

  listRecentCallLogs(limit = 20): unknown[] {
    return this.db.prepare(`SELECT * FROM call_log ORDER BY id DESC LIMIT ?`).all(limit);
  }

  insertEvalRun(row: EvalRunRow): void {
    this.db
      .prepare(
        `INSERT INTO eval_run (run_id, ts, prompt_set_path, models, judge_used)
         VALUES (@runId, @ts, @promptSetPath, @models, @judgeUsed)`,
      )
      .run({
        runId: row.runId,
        ts: new Date().toISOString(),
        promptSetPath: row.promptSetPath,
        models: JSON.stringify(row.models),
        judgeUsed: row.judgeUsed ? 1 : 0,
      });
  }

  insertEvalResult(row: EvalResultRow): void {
    this.db
      .prepare(
        `INSERT INTO eval_result
          (run_id, prompt_id, model, latency_ms, response, passed, judge_score, price_usd, error_message)
         VALUES (@runId, @promptId, @model, @latencyMs, @response, @passed, @judgeScore, @priceUsd, @errorMessage)`,
      )
      .run({
        runId: row.runId,
        promptId: row.promptId,
        model: row.model,
        latencyMs: row.latencyMs,
        response: row.response,
        passed: row.passed === null ? null : row.passed ? 1 : 0,
        judgeScore: row.judgeScore,
        priceUsd: row.priceUsd,
        errorMessage: row.errorMessage,
      });
  }

  getEvalRunResults(runId: string): unknown[] {
    return this.db.prepare(`SELECT * FROM eval_result WHERE run_id = ? ORDER BY id ASC`).all(runId);
  }

  close(): void {
    this.db.close();
  }
}
