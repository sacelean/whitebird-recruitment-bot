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
