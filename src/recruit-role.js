export async function resolveRecruitRole(guild, botMember) {
  const roles = await guild.roles.fetch();
  const matches = [...roles.values()].filter(role => role.name?.trim().toLocaleLowerCase('es-ES') === 'recluta');
  if (matches.length !== 1) throw new Error('Debe existir exactamente un rol llamado Recluta.');
  const role = matches[0];
  if (role.managed || botMember.roles.highest.comparePositionTo(role) <= 0) {
    throw new Error('El rol Recluta debe ser gestionable y estar por debajo del bot de Apply.');
  }
  return role;
}

export async function assignRecruitRole(applicant, role) {
  if (!applicant.roles.cache.has(role.id)) {
    await applicant.roles.add(role.id, 'Apply aceptado: incorporación como Recluta');
  }
}
