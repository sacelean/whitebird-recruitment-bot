import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const databasePath = resolve(process.env.DATABASE_PATH || './data/whitebird-recruitment.sqlite');
mkdirSync(dirname(databasePath), { recursive: true });

export const db = new Database(databasePath);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS panels (
    guild_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

export function getPanel(guildId) {
  return db.prepare('SELECT channel_id, message_id FROM panels WHERE guild_id = ?').get(guildId);
}

export function savePanel(guildId, channelId, messageId) {
  db.prepare(`INSERT INTO panels (guild_id, channel_id, message_id) VALUES (?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET channel_id=excluded.channel_id,
    message_id=excluded.message_id, updated_at=CURRENT_TIMESTAMP`)
    .run(guildId, channelId, messageId);
}

// One durable record per application. Retries update the same decision.
db.exec(`CREATE TABLE IF NOT EXISTS recruitment_decisions (
  guild_id TEXT NOT NULL, application_channel_id TEXT NOT NULL,
  applicant_id TEXT NOT NULL, applicant TEXT NOT NULL,
  officer_id TEXT NOT NULL, officer TEXT NOT NULL,
  character TEXT NOT NULL, realm TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('aceptada','rechazada')),
  reason TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
  linked INTEGER NOT NULL DEFAULT 0, channel_created INTEGER NOT NULL DEFAULT 0,
  raider_channel_id TEXT, decided_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(guild_id, application_channel_id)
)`);

export function beginDecision(interaction, applicant, character, realm, decision, reason = '') {
  db.prepare(`INSERT INTO recruitment_decisions
    (guild_id, application_channel_id, applicant_id, applicant, officer_id, officer, character, realm, decision, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, application_channel_id) DO UPDATE SET
      officer_id=excluded.officer_id, officer=excluded.officer, character=excluded.character,
      realm=excluded.realm, reason=excluded.reason, updated_at=CURRENT_TIMESTAMP
    WHERE recruitment_decisions.decision=excluded.decision`)
    .run(interaction.guildId, interaction.channelId, applicant.id, applicant.user.tag,
      interaction.user.id, interaction.user.tag, character, realm, decision, reason);
  const record = db.prepare('SELECT decision FROM recruitment_decisions WHERE guild_id=? AND application_channel_id=?')
    .get(interaction.guildId, interaction.channelId);
  if (record.decision !== decision) throw new Error('La solicitud ya tiene otra decisión registrada.');
}

export function recordDecisionProgress(interaction, { linked = false, channelId = null, completed = false } = {}) {
  db.prepare(`UPDATE recruitment_decisions SET linked=MAX(linked, ?),
    channel_created=MAX(channel_created, ?), raider_channel_id=COALESCE(?, raider_channel_id),
    status=CASE WHEN ? THEN 'completed' ELSE status END, updated_at=CURRENT_TIMESTAMP
    WHERE guild_id=? AND application_channel_id=?`)
    .run(Number(linked), Number(Boolean(channelId)), channelId, Number(completed), interaction.guildId, interaction.channelId);
}
