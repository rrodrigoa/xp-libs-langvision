const minute = 60_000;

export function modelTimeoutMs(profile, env = process.env) {
  return profile?.timeoutMs ?? (profile?.provider === 'openai-compatible'
    ? 2 * minute : configuredMinutes(env.LANGVISION_OLLAMA_TIMEOUT_MINUTES, 15));
}

export function configuredMinutes(value, fallback) {
  const minutes = Number(value);
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= 120 ? minutes * minute : fallback * minute;
}

export function activeBudget(db, executionId, limit, controller, now = Date.now) {
  db.exec(`CREATE TABLE IF NOT EXISTS ai_active_budgets (
    execution_id TEXT PRIMARY KEY, limit_ms INTEGER NOT NULL, used_ms INTEGER NOT NULL, started_ms INTEGER)`);
  const start = now();
  const row = db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO ai_active_budgets VALUES (?,?,0,NULL)').run(executionId, limit);
    const current = db.prepare('SELECT * FROM ai_active_budgets WHERE execution_id=?').get(executionId);
    // A normal pause closes its segment. An unclosed segment is charged conservatively after restart.
    const used = current.used_ms + (current.started_ms === null ? 0 : Math.max(0, start - current.started_ms));
    db.prepare('UPDATE ai_active_budgets SET used_ms=?, started_ms=? WHERE execution_id=?').run(used, start, executionId);
    return { remaining: current.limit_ms - used, used };
  })();
  const expire = () => controller.abort(Object.assign(new Error('The agent exhausted its active execution budget. Time waiting for approval is excluded.'), { code: 'agent_active_timeout' }));
  const timer = row.remaining > 0 ? setTimeout(expire, row.remaining) : undefined;
  timer?.unref();
  if (!timer) expire();
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    db.prepare('UPDATE ai_active_budgets SET used_ms=?, started_ms=NULL WHERE execution_id=? AND started_ms=?')
      .run(row.used + Math.max(0, now() - start), executionId, start);
  };
}
