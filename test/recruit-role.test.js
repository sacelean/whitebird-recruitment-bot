import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRecruitRole, assignRecruitRole } from '../src/recruit-role.js';

function setup(extra = {}) {
  const role = { id: 'recruit', name: ' Recluta ', managed: false, ...extra };
  const guild = { roles: { fetch: async () => new Map([[role.id, role]]) } };
  const bot = { roles: { highest: { comparePositionTo: () => 1 } } };
  return { role, guild, bot };
}

test('resuelve Recluta sin distinguir mayúsculas y espacios', async () => {
  const { guild, bot, role } = setup({ name: ' RECLUTA ' });
  assert.equal(await resolveRecruitRole(guild, bot), role);
});
test('rechaza rol ausente o ambiguo', async () => {
  const { guild, bot, role } = setup();
  guild.roles.fetch = async () => new Map();
  await assert.rejects(resolveRecruitRole(guild, bot), /exactamente un/);
  guild.roles.fetch = async () => new Map([['one', role], ['two', { ...role, id: 'two' }]]);
  await assert.rejects(resolveRecruitRole(guild, bot), /exactamente un/);
});
test('rechaza roles de integración y jerarquía insuficiente', async () => {
  const { guild, bot } = setup({ managed: true });
  await assert.rejects(resolveRecruitRole(guild, bot), /gestionable/);
  for (const comparison of [0, -1]) {
    const state = setup();
    state.bot.roles.highest.comparePositionTo = () => comparison;
    await assert.rejects(resolveRecruitRole(state.guild, state.bot), /por debajo/);
  }
});
test('asigna inmediatamente Recluta y reintenta sin duplicarlo', async () => {
  const { role } = setup();
  const calls = [];
  const cache = new Map();
  const applicant = { roles: { cache, add: async id => { cache.set(id, role); calls.push(id); } } };
  await assignRecruitRole(applicant, role);
  await assignRecruitRole(applicant, role);
  assert.deepEqual(calls, [role.id]);
});
test('propaga rechazo de Discord para dejar pendiente la aceptación', async () => {
  const { role } = setup();
  const applicant = { roles: { cache: new Map(), add: async () => { throw new Error('Missing Permissions'); } } };
  await assert.rejects(assignRecruitRole(applicant, role), /Missing Permissions/);
});
