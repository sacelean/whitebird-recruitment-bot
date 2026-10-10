const PROFILE_ENDPOINT = 'https://raider.io/api/v1/characters/profile';

export function wowRealmSlug(realm) {
  return realm
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function displayRaidName(raid) {
  return String(raid || '')
    .replace(/^tier-[^-]+-/, '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) return null;
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function progressionEntries(profile) {
  const progression = profile?.raid_progression;
  if (!progression || typeof progression !== 'object') return [];
  return Object.entries(progression).filter(([, raid]) => raid && typeof raid === 'object');
}

function currentRaidProgress(profile) {
  const raids = progressionEntries(profile);
  if (!raids.length) return 'No disponible';
  return raids.slice(0, 3).map(([slug, raid]) => {
    const name = raid.name || raid.raid_name || displayRaidName(slug);
    const summary = raid.summary || [
      raid.normal_bosses_killed ? `${raid.normal_bosses_killed}/${raid.total_bosses} N` : '',
      raid.heroic_bosses_killed ? `${raid.heroic_bosses_killed}/${raid.total_bosses} H` : '',
      raid.mythic_bosses_killed ? `${raid.mythic_bosses_killed}/${raid.total_bosses} M` : ''
    ].filter(Boolean).join(' · ') || 'Sin progreso';
    return `**${name}:** ${summary}`;
  }).join('\n');
}

function currentBossKills(profile) {
  const raids = progressionEntries(profile).slice(0, 3).map(([, raid]) => raid);
  if (!raids.length) return 'No disponible';
  const totals = ['normal', 'heroic', 'mythic'].map((difficulty) =>
    raids.reduce((sum, raid) => sum + (Number(raid[`${difficulty}_bosses_killed`]) || 0), 0)
  );
  return `**N:** ${totals[0]} · **H:** ${totals[1]} · **M:** ${totals[2]}`;
}

export function makeRaiderIoFields(profile, character, realm) {
  const gearLevel = profile?.gear?.item_level_equipped;
  const season = profile?.mythic_plus_scores_by_season?.[0];
  const bestRun = profile?.mythic_plus_best_runs?.[0];
  const dungeon = bestRun
    ? `**+${bestRun.mythic_level ?? '?'}** - ${bestRun.short_name || bestRun.dungeon || 'M+'}${formatDuration(bestRun.clear_time_ms) ? ` - *${formatDuration(bestRun.clear_time_ms)}*` : ''}`
    : 'No disponible';
  const characterUrl = `https://worldofwarcraft.com/en-eu/character/${encodeURIComponent(wowRealmSlug(realm))}/${encodeURIComponent(character)}`;
  return [
    { name: 'Nivel de objeto', value: gearLevel ? `[**${Math.round(gearLevel)} ilvl**](${characterUrl})` : `[Ver personaje](${characterUrl})`, inline: true },
    { name: 'Recent Raid Progression', value: currentRaidProgress(profile), inline: false },
    { name: 'Boss Kills', value: currentBossKills(profile), inline: true },
    { name: 'M+ Score', value: Number.isFinite(season?.scores?.all) ? String(Math.round(season.scores.all)) : 'No disponible', inline: true },
    { name: 'Best M+ Dungeon', value: dungeon, inline: true },
    { name: 'Achievement Points', value: Number.isFinite(profile?.achievement_points) ? String(profile.achievement_points) : 'No disponible', inline: true }
  ];
}

export async function fetchRaiderIoProfile(character, realm) {
  const url = new URL(PROFILE_ENDPOINT);
  url.search = new URLSearchParams({
    region: 'eu',
    realm: wowRealmSlug(realm),
    name: character,
    fields: 'gear,raid_progression,mythic_plus_scores_by_season:current,mythic_plus_best_runs'
  }).toString();
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) {
      console.warn(`Raider.IO no devolvió datos para ${character}-${realm} (HTTP ${response.status}).`);
      return null;
    }
    return await response.json();
  } catch (error) {
    console.warn(`No se pudieron consultar datos de Raider.IO para ${character}-${realm}: ${error.message}`);
    return null;
  }
}
