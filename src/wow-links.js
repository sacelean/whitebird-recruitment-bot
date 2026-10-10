import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function saveWowLink(guildId, userId, characterName, realmSlug, raiderChannelId) {
  const configuredPath = process.env.WOW_ROLE_SYNC_DATABASE_PATH;
  if (!configuredPath) {
    throw new Error('Falta WOW_ROLE_SYNC_DATABASE_PATH; configura el acceso compartido a la base de datos del bot de sync.');
  }

  const databasePath = resolve(configuredPath);
  if (!existsSync(databasePath)) {
    throw new Error(`No existe ${databasePath}; comprueba que WOW_ROLE_SYNC_DATA_DIR apunta a la carpeta data real del bot de sync.`);
  }
  const database = new Database(databasePath, { timeout: 10_000 });
  try {
    database.pragma('journal_mode = WAL');
    database.exec(`
      CREATE TABLE IF NOT EXISTS wow_links (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        character_name TEXT NOT NULL,
        realm_slug TEXT NOT NULL,
        raider_channel_id TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (guild_id, user_id),
        UNIQUE (guild_id, character_name, realm_slug)
      );
    `);
    database.transaction(() => {
      const columns = new Set(database.pragma('table_info(wow_links)').map((column) => column.name));
      if (!columns.has('raider_channel_id')) database.exec('ALTER TABLE wow_links ADD COLUMN raider_channel_id TEXT');
    }).immediate();
    return database.prepare(`INSERT INTO wow_links (guild_id, user_id, character_name, realm_slug, raider_channel_id)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(guild_id, user_id) DO UPDATE SET character_name=excluded.character_name,
      realm_slug=excluded.realm_slug, raider_channel_id=COALESCE(excluded.raider_channel_id, wow_links.raider_channel_id),
      updated_at=CURRENT_TIMESTAMP`)
      .run(guildId, userId, characterName, realmSlug, raiderChannelId || null);
  } finally {
    database.close();
  }
}
