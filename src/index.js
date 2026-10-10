import 'dotenv/config';
import {
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle
} from 'discord.js';
import { getPanel, savePanel } from './database.js';
import { saveWowLink } from './wow-links.js';
import { fetchRaiderIoProfile, makeRaiderIoFields, wowRealmSlug } from './raiderio.js';

const token = process.env.DISCORD_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;
if (!token || !guildId) throw new Error('Configura DISCORD_TOKEN y DISCORD_GUILD_ID en .env.');

const officerRoleIds = new Set((process.env.OFFICER_ROLE_IDS || '').split(',').map((id) => id.trim()).filter(Boolean));
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const questionIds = ['character', 'realm', 'class', 'experience', 'availability'];
const raiderIoFieldNames = new Set(['Nivel de objeto', 'Recent Raid Progression', 'Boss Kills', 'M+ Score', 'Best M+ Dungeon', 'Achievement Points']);
const raiderIoRefreshes = new Map();
const questionLabels = [
  process.env.APPLY_QUESTION_CHARACTER || 'Nombre de tu personaje principal',
  process.env.APPLY_QUESTION_REALM || 'Reino',
  process.env.APPLY_QUESTION_CLASS || 'Clase y especialización',
  process.env.APPLY_QUESTION_EXPERIENCE || 'Experiencia en raids',
  process.env.APPLY_QUESTION_AVAILABILITY || 'Disponibilidad y motivación para unirte'
];
const defaultAcceptedMessage = "¡Enhorabuena, {user}! Tu solicitud ha sido aceptada. Tu canal privado de raider es {channel}.";
const applyIntroduction = `Hola 👋 Te cuento un poco cómo funcionamos para que tengas claro qué tipo de guild somos.

Somos una guild de gente veterana que disfruta el progreso. Nos gusta avanzar, hacer las cosas bien y notar que cada semana el grupo mejora. No somos de correr sin cabeza, pero tampoco de quedarnos estancados porque «ya caerá».

Raidamos de lunes a jueves, de 23:30 a 1:30. Gestionamos el loot con RCLootCouncil y la asistencia con WoWAudit. Nos gusta tenerlo todo organizado para que, dentro de raid, podamos centrarnos en jugar.

Pedimos compromiso razonable:
• Avisar asistencias
• Venir preparado
• Conocer las mecánicas
• Y, sobre todo, buena actitud

Aquí nadie es perfecto, pero sí pedimos ganas de mejorar. Morimos, aprendemos, ajustamos… y volvemos a tirar. Sin dramas innecesarios ni gritos por voice.

El ambiente es importante para nosotros. Somos competitivos cuando toca, pero también sabemos reírnos cuando el boss decide que hoy no es el día (porque siempre hay un día así 😏).

Si buscas una guild estable, con rumbo, donde el progreso se disfruta y el grupo suma más que el ego individual, probablemente encajemos.`;

function isOfficer(interaction) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  const roles = interaction.member?.roles?.cache;
  return roles ? [...officerRoleIds].some((id) => roles.has(id)) : false;
}

function unauthorizedReply() {
  return { content: 'Este comando está reservado a oficiales.', flags: MessageFlags.Ephemeral };
}

function fillTemplate(template, values) {
  return Object.entries(values).reduce((text, [key, value]) => text.split(`{${key}}`).join(String(value)), template);
}

function getApplicationTopic(channel) {
  const match = channel?.topic?.match(/^whitebird-apply(?:(-closed|-rejected))?:(\d+):(\d+)$/);
  if (!match) return null;
  return { status: match[1] || 'open', guildId: match[2], applicantId: match[3] };
}

function applicationUserId(interaction) {
  if (interaction.isChatInputCommand()) return getApplicationTopic(interaction.channel)?.applicantId || null;
  return interaction.customId.split(':').at(-1);
}

function applicationMismatchReply(interaction, applicantId) {
  const topic = getApplicationTopic(interaction.channel);
  const validApplicantId = /^\d+$/.test(applicantId || '') ? applicantId : null;
  const content = topic && validApplicantId === topic.applicantId
    ? `El candidato coincide (<@${topic.applicantId}>), pero el estado guardado del canal es **${topic.status === '-closed' ? 'cerrado/aceptado' : 'rechazado'}**. Solo se pueden procesar solicitudes abiertas.`
    : topic && validApplicantId
      ? `Este canal está vinculado a <@${topic.applicantId}> (ID \`${topic.applicantId}\`), pero la acción intenta procesar a <@${validApplicantId}> (ID \`${validApplicantId}\`).`
      : 'No encuentro en este canal la identificación de una solicitud válida. Comprueba que estás dentro del canal de apply original y que no se modificó su tema.';
  return interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

function rejectionReasonModal(applicantId) {
  const reasonInput = new TextInputBuilder()
    .setCustomId('reason')
    .setLabel('Motivo del rechazo')
    .setStyle(TextInputStyle.Paragraph)
    .setMinLength(3)
    .setMaxLength(500)
    .setRequired(true)
    .setPlaceholder('Explica brevemente la decisión para incluirla en la transcripción.');
  return new ModalBuilder()
    .setCustomId(`apply:reject-reason:${applicantId}`)
    .setTitle('Rechazar solicitud')
    .addComponents(new ActionRowBuilder().addComponents(reasonInput));
}

function applicationEditModal(applicantId, character, realm) {
  const characterInput = new TextInputBuilder()
    .setCustomId('character')
    .setLabel('Nombre del personaje main')
    .setStyle(TextInputStyle.Short)
    .setMinLength(2)
    .setMaxLength(100)
    .setValue(character.slice(0, 100))
    .setRequired(true);
  const realmInput = new TextInputBuilder()
    .setCustomId('realm')
    .setLabel('Reino')
    .setStyle(TextInputStyle.Short)
    .setMinLength(2)
    .setMaxLength(100)
    .setValue(realm.slice(0, 100))
    .setRequired(true);
  return new ModalBuilder()
    .setCustomId(`apply:edit-main-submit:${applicantId}`)
    .setTitle('Corregir main del apply')
    .addComponents(
      new ActionRowBuilder().addComponents(characterInput),
      new ActionRowBuilder().addComponents(realmInput)
    );
}

async function findApplicationMessage(channel) {
  const messages = await channel.messages.fetch({ limit: 100 });
  return messages.find((message) => message.embeds.some((embed) => embed.title?.startsWith('Apply · '))) || null;
}

function withRaiderIoFields(applicationEmbed, profile, character, realm, { pending = false } = {}) {
  const embedData = applicationEmbed instanceof EmbedBuilder ? applicationEmbed.toJSON() : applicationEmbed;
  const fields = (embedData.fields || []).filter((field) => !raiderIoFieldNames.has(field.name));
  fields.splice(questionIds.length, 0, ...makeRaiderIoFields(profile, character, realm, { pending }));
  return EmbedBuilder.from(embedData).setFields(fields);
}

async function refreshRaiderIoCard(applicationMessage, character, realm, signal) {
  const profile = await fetchRaiderIoProfile(character, realm, { signal });
  if (signal.aborted) return;
  const latestMessage = await applicationMessage.fetch().catch(() => null);
  const latestEmbed = latestMessage?.embeds.find((embed) => embed.title?.startsWith('Apply · '));
  if (!latestMessage || !latestEmbed) return;
  const latestCharacter = latestEmbed.title.slice('Apply · '.length).trim();
  const latestRealm = latestEmbed.fields.find((field) => field.name === questionLabels[1].slice(0, 256))?.value?.trim() || '';
  if (latestCharacter !== character || latestRealm !== realm) return;
  await latestMessage.edit({ embeds: [withRaiderIoFields(latestEmbed, profile, character, realm)] });
}

function refreshRaiderIoCardInBackground(applicationMessage, character, realm) {
  const messageId = applicationMessage.id;
  raiderIoRefreshes.get(messageId)?.controller.abort();
  const controller = new AbortController();
  raiderIoRefreshes.set(messageId, { controller });
  void refreshRaiderIoCard(applicationMessage, character, realm, controller.signal)
    .catch((error) => console.error(`No se pudo actualizar la tarjeta de Raider.IO para ${character}-${realm}:`, error))
    .finally(() => {
      if (raiderIoRefreshes.get(messageId)?.controller === controller) raiderIoRefreshes.delete(messageId);
    });
}

async function openApplicationEdit(interaction) {
  if (interaction.channel?.type !== ChannelType.GuildText) {
    return interaction.reply({ content: 'Abre el formulario dentro del canal del apply.', flags: MessageFlags.Ephemeral });
  }
  const applicationTopic = getApplicationTopic(interaction.channel);
  const applicantId = interaction.isChatInputCommand() ? applicationTopic?.applicantId : interaction.customId.split(':').at(-1);
  if (!applicantId) return applicationMismatchReply(interaction, 'desconocido');
  if (applicationTopic?.status !== 'open' || applicationTopic.applicantId !== applicantId) {
    return applicationMismatchReply(interaction, applicantId);
  }
  if (interaction.user.id !== applicantId && !isOfficer(interaction)) {
    return interaction.reply({ content: 'Solo el candidato o un oficial puede corregir este apply.', flags: MessageFlags.Ephemeral });
  }
  const applicationMessage = await findApplicationMessage(interaction.channel);
  const applicationEmbed = applicationMessage?.embeds.find((embed) => embed.title?.startsWith('Apply · '));
  if (!applicationEmbed) {
    return interaction.reply({ content: 'No encuentro la ficha del apply en este canal.', flags: MessageFlags.Ephemeral });
  }
  const character = applicationEmbed.title.slice('Apply · '.length).trim();
  const realm = applicationEmbed.fields.find((field) => field.name === questionLabels[1].slice(0, 256))?.value?.trim() || '';
  return interaction.showModal(applicationEditModal(applicantId, character, realm));
}

async function updateApplicationMain(interaction) {
  const applicantId = interaction.customId.split(':').at(-1);
  const applicationTopic = getApplicationTopic(interaction.channel);
  if (applicationTopic?.status !== 'open' || applicationTopic.applicantId !== applicantId) {
    return applicationMismatchReply(interaction, applicantId);
  }
  if (interaction.user.id !== applicantId && !isOfficer(interaction)) {
    return interaction.reply({ content: 'Solo el candidato o un oficial puede corregir este apply.', flags: MessageFlags.Ephemeral });
  }

  const character = interaction.fields.getTextInputValue('character').trim();
  const realm = interaction.fields.getTextInputValue('realm').trim();
  if (!character || !realm) return interaction.reply({ content: 'Indica el personaje y el reino.', flags: MessageFlags.Ephemeral });
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const applicationMessage = await findApplicationMessage(interaction.channel);
  const applicationEmbed = applicationMessage?.embeds.find((embed) => embed.title?.startsWith('Apply · '));
  if (!applicationMessage || !applicationEmbed) return interaction.editReply('No encuentro la ficha del apply en este canal.');
  const previousCharacter = applicationEmbed.title.slice('Apply · '.length).trim();
  const previousRealm = applicationEmbed.fields.find((field) => field.name === questionLabels[1].slice(0, 256))?.value?.trim() || '';
  if (character === previousCharacter && realm === previousRealm) {
    await applicationMessage.edit({ embeds: [withRaiderIoFields(applicationEmbed, null, character, realm, { pending: true })] });
    refreshRaiderIoCardInBackground(applicationMessage, character, realm);
    return interaction.editReply('El main y el reino no han cambiado. Estoy actualizando las estadísticas de Raider.IO en la ficha.');
  }

  const fields = applicationEmbed.fields.filter((field) => !raiderIoFieldNames.has(field.name)).map((field) => {
    if (field.name === questionLabels[0].slice(0, 256)) return { ...field, value: character };
    if (field.name === questionLabels[1].slice(0, 256)) return { ...field, value: realm };
    if (field.name === 'Raider.IO') {
      return { ...field, value: `[Ver perfil EU](https://raider.io/characters/eu/${encodeURIComponent(wowRealmSlug(realm))}/${encodeURIComponent(character)})` };
    }
    if (field.name === 'Warcraft Logs') {
      return { ...field, value: `[Ver perfil EU](https://www.warcraftlogs.com/character/eu/${encodeURIComponent(wowRealmSlug(realm))}/${encodeURIComponent(character)})` };
    }
    return { ...field };
  });
  const updatedEmbed = EmbedBuilder.from(applicationEmbed)
    .setTitle(`Apply · ${character}`)
    .setFields(fields);
  const pendingEmbed = withRaiderIoFields(updatedEmbed, null, character, realm, { pending: true });
  await applicationMessage.edit({ embeds: [pendingEmbed] });

  const oldChannelName = interaction.channel.name;
  const newChannelName = `apply-${cleanChannelName(character)}`.slice(0, 100);
  let renameNote = '';
  if (newChannelName !== oldChannelName) {
    try {
      await interaction.channel.setName(newChannelName, `Main corregido por ${interaction.user.tag}`);
    } catch {
      renameNote = ' No pude cambiar el nombre del canal; un oficial puede actualizarlo manualmente.';
    }
  }
  await interaction.channel.send({
    content: `Datos del main corregidos por <@${interaction.user.id}>: **${previousCharacter} · ${previousRealm}** → **${character} · ${realm}**.`,
    allowedMentions: { users: [interaction.user.id], roles: [], parse: [] }
  });
  refreshRaiderIoCardInBackground(applicationMessage, character, realm);
  return interaction.editReply(`Apply actualizado. El main ahora es **${character} · ${realm}**.${renameNote}`);
}

async function fetchAllMessages(channel) {
  const messages = [];
  let before;
  while (true) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (!batch.size) break;
    messages.push(...batch.values());
    if (batch.size < 100) break;
    before = batch.last().id;
  }
  return messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

function renderTranscript(messages, { applicant, character, realm, resolvedBy, outcome, reason }) {
  const lines = [
    'TRANSCRIPCIÓN DE SOLICITUD WHITEBIRD',
    `Candidato: ${applicant.user.tag} (${applicant.id})`,
    `Personaje: ${character}`,
    `Reino: ${realm}`,
    `${outcome} por: ${resolvedBy.tag} (${resolvedBy.id})`,
    `Fecha de ${outcome.toLowerCase()}: ${new Date().toISOString()}`,
    ...(reason ? [`Motivo del rechazo: ${reason}`] : []),
    '',
    'HISTORIAL DEL CANAL',
    ''
  ];
  for (const message of messages) {
    lines.push(`[${new Date(message.createdTimestamp).toISOString()}] ${message.author.tag} (${message.author.id})`);
    if (message.content) lines.push(message.content);
    for (const embed of message.embeds) {
      if (embed.title) lines.push(`Título: ${embed.title}`);
      if (embed.description) lines.push(embed.description);
      for (const field of embed.fields) lines.push(`${field.name}: ${field.value}`);
      const mediaUrl = embed.video?.url || embed.image?.url || embed.thumbnail?.url;
      if (mediaUrl) lines.push(`${/\.gif(?:v)?(?:\?|$)/i.test(mediaUrl) ? 'GIF' : 'Multimedia'}: ${mediaUrl}`);
      else if (embed.url) lines.push(`Enlace insertado: ${embed.url}`);
    }
    for (const attachment of message.attachments.values()) {
      const isGif = attachment.contentType?.includes('image/gif') || /\.gif(?:v)?$/i.test(attachment.name || attachment.url);
      lines.push(`${isGif ? 'GIF' : 'Adjunto'}: ${attachment.name || 'archivo'} — ${attachment.url}`);
    }
    for (const sticker of message.stickers.values()) lines.push(`Sticker: ${sticker.name}${sticker.url ? ` — ${sticker.url}` : ''}`);
    if (!message.content && message.embeds.length === 0 && message.attachments.size === 0 && message.stickers.size === 0) {
      lines.push('[Mensaje sin texto ni adjuntos disponibles en el historial de Discord]');
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function findEntryChannel(guild) {
  const entryChannelId = process.env.ENTRY_CHANNEL_ID;
  if (!entryChannelId) throw new Error('Falta ENTRY_CHANNEL_ID en .env.');
  const channel = await guild.channels.fetch(entryChannelId);
  if (!channel || channel.type !== ChannelType.GuildText) throw new Error('ENTRY_CHANNEL_ID debe ser un canal de texto de este servidor.');
  const botMember = await guild.members.fetchMe();
  const permissions = channel.permissionsFor(botMember);
  const canArchive = permissions
    && permissions.has(PermissionFlagsBits.ViewChannel)
    && permissions.has(PermissionFlagsBits.SendMessages)
    && permissions.has(PermissionFlagsBits.ReadMessageHistory)
    && permissions.has(PermissionFlagsBits.AttachFiles);
  if (!canArchive) throw new Error('El bot necesita Ver canales, Enviar mensajes, Leer historial y Adjuntar archivos en el canal de entrada.');
  return channel;
}

function applyPanelPayload() {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Reclutamiento · Whitebird')
    .setDescription('¿Quieres unirte a la guild? Pulsa **New Apply** y completa el formulario. Todas las preguntas son obligatorias.');
  const button = new ButtonBuilder()
    .setCustomId('apply:new')
    .setLabel('New Apply')
    .setStyle(ButtonStyle.Primary);
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(button)] };
}

function applyModal() {
  const modal = new ModalBuilder()
    .setCustomId('apply:submit')
    .setTitle('Solicitud para Whitebird');
  const inputs = questionIds.map((id, index) => {
    const longAnswer = index >= 3;
    const input = new TextInputBuilder()
      .setCustomId(id)
      .setLabel(questionLabels[index].slice(0, 45))
      .setStyle(longAnswer ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(longAnswer ? 1000 : 100);
    if (index === 0) input.setPlaceholder('Personaje que usas como main');
    if (index === 1) input.setPlaceholder('Reino donde está tu personaje');
    return new ActionRowBuilder().addComponents(input);
  });
  return modal.addComponents(...inputs);
}

function cleanChannelName(value) {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'recluta';
}

async function getPrivateChannelSetup(guild, categoryEnvName) {
  const categoryId = process.env[categoryEnvName];
  if (!categoryId) throw new Error(`Falta ${categoryEnvName} en .env.`);
  if (!officerRoleIds.size) throw new Error('Configura OFFICER_ROLE_IDS para que los oficiales puedan ver los canales privados.');
  const category = await guild.channels.fetch(categoryId);
  if (!category || category.type !== ChannelType.GuildCategory) throw new Error(`${categoryEnvName} no apunta a una categoría de este servidor.`);
  const roles = [];
  for (const roleId of officerRoleIds) {
    const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId);
    if (!role) throw new Error(`No existe el rol de oficial ${roleId}.`);
    roles.push(role);
  }
  const botMember = await guild.members.fetchMe();
  return { category, roles, botMember };
}

function privateOverwrites(guild, targetId, roles, botId, additionalBotIds = []) {
  const botPermissions = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels];
  return [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: targetId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    ...roles.map((role) => ({ id: role.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] })),
    ...[...new Set([botId, ...additionalBotIds])].map((id) => ({ id, allow: botPermissions }))
  ];
}

async function publishApplyPanel(interaction) {
  if (!isOfficer(interaction)) return interaction.reply(unauthorizedReply());
  if (interaction.channel?.type !== ChannelType.GuildText) {
    return interaction.reply({ content: 'Ejecuta `/apply-panel` dentro del canal donde quieres dejar el panel.', flags: MessageFlags.Ephemeral });
  }
  if (!interaction.appPermissions?.has(PermissionFlagsBits.SendMessages)) {
    return interaction.reply({ content: 'El bot no tiene permiso para enviar mensajes en este canal.', flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const previous = getPanel(guildId);
  const oldMessage = previous?.channel_id === interaction.channelId
    ? await interaction.channel.messages.fetch({ message: previous.message_id, force: true }).catch(() => null)
    : null;
  const recentMessages = await interaction.channel.messages.fetch({ limit: 100 });
  const introMessageStart = 'Hola 👋 Te cuento un poco cómo funcionamos';
  let introMessage = recentMessages.find((message) => message.author.id === interaction.client.user.id && message.content.startsWith(introMessageStart));
  const introContent = applyIntroduction;

  if (oldMessage && introMessage && introMessage.createdTimestamp < oldMessage.createdTimestamp) {
    await introMessage.edit(introContent);
    try {
      await oldMessage.edit(applyPanelPayload());
      return interaction.editReply('He actualizado la introducción y el panel de applies en este canal.');
    } catch (error) {
      if (error?.code !== 10008) throw error;
      console.warn(`El panel guardado ${previous.message_id} ya no existe; se publicará uno nuevo.`);
    }
  } else if (oldMessage) {
    await oldMessage.delete();
  }

  if (introMessage) {
    await introMessage.edit(introContent);
  } else {
    introMessage = await interaction.channel.send({ content: introContent, allowedMentions: { parse: [] } });
  }
  const message = await interaction.channel.send(applyPanelPayload());
  savePanel(guildId, interaction.channelId, message.id);
  return interaction.editReply(`Introducción y panel de applies publicados en ${interaction.channel}.`);
}

async function submitApplication(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!interaction.appPermissions?.has(PermissionFlagsBits.ManageChannels)) {
    return interaction.editReply('El bot necesita **Gestionar canales** para crear tu canal de solicitud. No se ha guardado la solicitud.');
  }
  const values = Object.fromEntries(questionIds.map((id) => [id, interaction.fields.getTextInputValue(id).trim()]));
  if (Object.values(values).some((value) => !value)) return interaction.editReply('Completa todas las respuestas antes de enviar el formulario.');

  const openTopic = `whitebird-apply:${guildId}:${interaction.user.id}`;
  const existing = interaction.guild.channels.cache.find((channel) => channel.type === ChannelType.GuildText && channel.topic === openTopic);
  if (existing) return interaction.editReply(`Ya tienes una solicitud abierta: ${existing}.`);

  const { category, roles, botMember } = await getPrivateChannelSetup(interaction.guild, 'APPLY_CATEGORY_ID');
  const channel = await interaction.guild.channels.create({
    name: `apply-${cleanChannelName(values.character)}`,
    type: ChannelType.GuildText,
    parent: category.id,
    topic: openTopic,
    permissionOverwrites: privateOverwrites(interaction.guild, interaction.user.id, roles, botMember.id),
    reason: `Apply enviado por ${interaction.user.tag}`
  });

  const answers = [values.character, values.realm, values.class, values.experience, values.availability];
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`Apply · ${values.character}`)
    .setDescription(`Solicitud enviada por <@${interaction.user.id}>`)
    .addFields([
      ...answers.map((value, index) => ({ name: questionLabels[index].slice(0, 256), value: value.slice(0, 1024) })),
      ...makeRaiderIoFields(null, values.character, values.realm, { pending: true }),
      {
        name: 'Raider.IO',
        value: `[Ver perfil EU](https://raider.io/characters/eu/${encodeURIComponent(wowRealmSlug(values.realm))}/${encodeURIComponent(values.character)})`,
        inline: true
      },
      {
        name: 'Warcraft Logs',
        value: `[Ver perfil EU](https://www.warcraftlogs.com/character/eu/${encodeURIComponent(wowRealmSlug(values.realm))}/${encodeURIComponent(values.character)})`,
        inline: true
      }
    ]);
  const template = process.env.APPLY_RECEIVED_MESSAGE || '¡Hola {user}! Hemos recibido tu apply para **{character}** · **{realm}**. Los oficiales de Whitebird lo revisarán aquí.';
  const content = fillTemplate(template, {
    user: `<@${interaction.user.id}>`,
    character: values.character,
    realm: values.realm,
    server: interaction.guild.name,
    channel: `<#${channel.id}>`
  });
  const decisionButtons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`apply:accept:${interaction.user.id}`).setLabel('Aceptar').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`apply:reject:${interaction.user.id}`).setLabel('Rechazar').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`apply:edit-main:${interaction.user.id}`).setLabel('Corregir main/reino').setStyle(ButtonStyle.Secondary)
  );
  let applicationMessage;
  try {
    applicationMessage = await channel.send({ content, embeds: [embed], components: [decisionButtons], allowedMentions: { users: [interaction.user.id], roles: [], parse: [] } });
  } catch (error) {
    await channel.delete('No se pudo publicar el contenido de la solicitud').catch(() => {});
    throw error;
  }
  refreshRaiderIoCardInBackground(applicationMessage, values.character, values.realm);
  return interaction.editReply(`Apply enviado. Tu canal privado es ${channel}; los oficiales lo revisarán allí.`);
}

async function acceptApplication(interaction) {
  if (!isOfficer(interaction)) return interaction.reply(unauthorizedReply());
  if (!interaction.appPermissions?.has(PermissionFlagsBits.ManageChannels)) {
    return interaction.reply({ content: 'El bot necesita **Gestionar canales** para completar la aceptación.', flags: MessageFlags.Ephemeral });
  }
  if (interaction.channel?.type !== ChannelType.GuildText) {
    return interaction.reply({ content: 'Ejecuta `/apply-aceptar` dentro del canal de solicitud correspondiente.', flags: MessageFlags.Ephemeral });
  }
  const applicantId = applicationUserId(interaction);
  const applicationTopic = getApplicationTopic(interaction.channel);
  const alreadyAccepted = applicationTopic?.status === '-closed';
  if (!applicantId || applicationTopic?.applicantId !== applicantId || !['open', '-closed'].includes(applicationTopic?.status)) {
    return applicationMismatchReply(interaction, applicantId || 'desconocido');
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!process.env.WOW_ROLE_SYNC_DATABASE_PATH) {
    return interaction.editReply('No puedo completar la aceptación: falta configurar el acceso compartido a la base del bot de sync (`WOW_ROLE_SYNC_DATABASE_PATH`).');
  }
  const guild = interaction.guild;
  const syncBotId = (process.env.WOW_ROLE_SYNC_BOT_ID || '').trim();
  if (!/^\d{15,22}$/.test(syncBotId)) {
    return interaction.editReply('No puedo completar la aceptación: configura `WOW_ROLE_SYNC_BOT_ID` con el ID del bot de sync roles.');
  }
  const syncBotMember = await guild.members.fetch(syncBotId).catch(() => null);
  if (!syncBotMember?.user.bot) {
    return interaction.editReply('No encuentro en este servidor el bot indicado en `WOW_ROLE_SYNC_BOT_ID`. Invítalo al servidor y revisa el ID antes de aceptar.');
  }
  const applyBotMember = await guild.members.fetchMe();
  if (!applyBotMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return interaction.editReply('No puedo completar la aceptación: **Whitebird Apply** necesita el permiso de servidor **Gestionar roles** para configurar los permisos del canal Raider. Concédeselo a su rol y vuelve a aceptar.');
  }
  if (!applyBotMember.permissions.has(PermissionFlagsBits.ManageChannels)) {
    return interaction.editReply('No puedo completar la aceptación: **Whitebird Apply** necesita el permiso de servidor **Gestionar canales** para dar acceso al bot de sync y renombrar el canal Raider. Concédeselo a su rol y vuelve a aceptar.');
  }
  if (applyBotMember.roles.highest.comparePositionTo(syncBotMember.roles.highest) <= 0) {
    return interaction.editReply('No puedo completar la aceptación: coloca el rol de **Whitebird Apply** por encima del rol más alto de **Whitebird Role Sync** en Ajustes del servidor → Roles. Luego vuelve a aceptar.');
  }
  const applicant = await guild.members.fetch(applicantId);
  const applicationMessages = await interaction.channel.messages.fetch({ limit: 100 });
  const applicationMessage = applicationMessages.find((message) => message.embeds.some((embed) => embed.title?.startsWith('Apply · ')));
  const applicationEmbed = applicationMessage?.embeds.find((embed) => embed.title?.startsWith('Apply · '));
  const character = applicationEmbed?.title?.slice('Apply · '.length).trim() || applicant.displayName;
  const realm = applicationEmbed?.fields?.find((field) => field.name === questionLabels[1].slice(0, 256))?.value?.trim() || 'reino';
  if (!applicationEmbed || !character || !realm || realm === 'reino') {
    return interaction.editReply('No puedo vincular el main porque la ficha no contiene un personaje y reino válidos. Usa `/apply-corregir` y vuelve a aceptar.');
  }
  const raiderChannelName = `raider-${cleanChannelName(character)}-${cleanChannelName(realm)}`.slice(0, 100);
  let entryChannel;
  try {
    entryChannel = await findEntryChannel(guild);
  } catch (error) {
    return interaction.editReply(`No puedo archivar la solicitud: ${error.message}`);
  }
  const archiveMarker = `apply-transcript:${interaction.channelId}`;
  const archiveMessages = await entryChannel.messages.fetch({ limit: 100 });
  let archiveMessage = archiveMessages.find((message) => message.content.includes(archiveMarker));
  const { category, roles, botMember } = await getPrivateChannelSetup(guild, 'RAIDER_CATEGORY_ID');
  const raiderTopic = `whitebird-raider:${guildId}:${applicant.id}`;
  let raiderChannel = guild.channels.cache.find((channel) => channel.type === ChannelType.GuildText && channel.topic === raiderTopic);
  if (!raiderChannel) {
    raiderChannel = await guild.channels.create({
      name: raiderChannelName,
      type: ChannelType.GuildText,
      parent: category.id,
      topic: raiderTopic,
      permissionOverwrites: privateOverwrites(guild, applicant.id, roles, botMember.id, [syncBotMember.id]),
      reason: `Solicitud aceptada por ${interaction.user.tag}`
    });
  } else {
    const channelPermissions = raiderChannel.permissionsFor(botMember);
    if (!channelPermissions?.has(PermissionFlagsBits.ViewChannel) || !channelPermissions.has(PermissionFlagsBits.ManageChannels)) {
      return interaction.editReply(`No puedo reutilizar ${raiderChannel}: al bot **Whitebird Apply** le faltan permisos para ver y gestionar ese canal. En los permisos del canal o de su categoría, permite **Ver canal** y **Gestionar canales** a Whitebird Apply; después vuelve a aceptar el apply.`);
    }
    if (raiderChannel.name !== raiderChannelName) {
      try {
        await raiderChannel.setName(raiderChannelName, 'Nombre actualizado al personaje y reino de la solicitud');
      } catch (error) {
        if (error?.code === 50001 || error?.code === 50013) {
          return interaction.editReply(`No pude renombrar ${raiderChannel}. Revisa que **Whitebird Apply** tenga **Ver canal** y **Gestionar canales** en ese canal o en su categoría. El apply sigue abierto; corrige los permisos y vuelve a aceptar.`);
        }
        throw error;
      }
    }
  }
  try {
    await raiderChannel.permissionOverwrites.edit(syncBotMember.id, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      ManageChannels: true
    }, `Acceso del bot de sync roles al canal Raider de ${applicant.user.tag}`);
  } catch (error) {
    if (error?.code === 50013 || error?.code === 50001) {
      return interaction.editReply(`Discord no permitió dar acceso a **Whitebird Role Sync** en ${raiderChannel}. Revisa que el rol de **Whitebird Apply** tenga **Gestionar roles** y **Gestionar canales**, que esté por encima del rol de **Whitebird Role Sync**, y que pueda ver ese canal. El apply sigue abierto; corrige los permisos y vuelve a aceptar.`);
    }
    throw error;
  }

  const raiderWelcomeMarker = 'Este será tu espacio personal con el staff para:';
  const recentRaiderMessages = await raiderChannel.messages.fetch({ limit: 100 });
  const hasRaiderWelcome = recentRaiderMessages.some((message) =>
    message.author.id === interaction.client.user.id && message.content.includes(raiderWelcomeMarker)
  );
  if (!hasRaiderWelcome) {
    const raiderWelcome = `<@${applicant.id}>\n\nBienvenido\n\nEste será tu espacio personal con el staff para:
• Feedback de raids
• Seguimiento de progreso
• Asistencia y disponibilidad
• Ajustes y mejoras personales
• Cualquier cosa que necesites hablar de forma directa

Ponte en este servidor de Discord un alias con el nombre de tu main para que nos sea fácil identificarte.

Si tienes profesiones subidas a nivel máximo, reacciona a este mensaje para que la gente te pueda pedir y pagar por crafteos:
https://discord.com/channels/1463652921898963146/1463652923253719247`;
    await raiderChannel.send({
      content: raiderWelcome,
      allowedMentions: { users: [applicant.id], roles: [], parse: [] }
    });
  }

  if (!archiveMessage) {
    const transcriptMessages = await fetchAllMessages(interaction.channel);
    const transcript = renderTranscript(transcriptMessages, { applicant, character, realm, resolvedBy: interaction.user, outcome: 'Aceptado' });
    const filename = `apply-${cleanChannelName(character)}-${cleanChannelName(realm)}-transcripcion.txt`.slice(0, 120);
    archiveMessage = await entryChannel.send({
      content: `Solicitud aceptada · ${character} · ${realm}\nCandidato: ${applicant.user.tag}\nPersonaje: ${character} · ${realm}\nOficial: ${interaction.user.tag}\nCanal archivado: ${interaction.channel.name}\n${archiveMarker}`,
      files: [new AttachmentBuilder(Buffer.from(transcript, 'utf8'), { name: filename })],
      allowedMentions: { parse: [] }
    });
  }

  const notifyMarker = `acceptance-notified:${interaction.channelId}`;
  const wasNotified = alreadyAccepted || archiveMessage.content.includes(notifyMarker);
  let delivery = 'mensaje directo';
  if (!wasNotified) {
    const template = process.env.APPLY_ACCEPTED_MESSAGE || defaultAcceptedMessage;
    const message = fillTemplate(template, {
      user: `<@${applicant.id}>`,
      character,
      realm,
      server: guild.name,
      channel: `<#${raiderChannel.id}>`
    });
    try {
      await applicant.send({ content: message, allowedMentions: { users: [applicant.id], roles: [], parse: [] } });
    } catch {
      delivery = 'canal de raider';
      await raiderChannel.send({ content: message, allowedMentions: { users: [applicant.id], roles: [], parse: [] } });
    }
    archiveMessage = await archiveMessage.edit({ content: `${archiveMessage.content}\n${notifyMarker}` });
  }

  try {
    saveWowLink(guildId, applicant.id, character, wowRealmSlug(realm), raiderChannel.id);
  } catch (error) {
    console.error(`No se pudo vincular ${applicant.id} con ${character}-${realm}:`, error);
    return interaction.editReply(`La bienvenida y la transcripción están guardadas, pero no pude registrar el main en el bot de sync. El canal de apply sigue abierto para que puedas corregir la configuración y reintentar. Detalle: ${error.message}`);
  }

  await interaction.channel.delete(`Apply archivado en ${entryChannel.name}; solicitud aceptada por ${interaction.user.tag}`);
  const deliveryText = wasNotified ? 'La bienvenida ya se había enviado.' : `Mensaje enviado por ${delivery}.`;
  return interaction.editReply(`Solicitud aceptada. ${deliveryText} Main **${character} · ${realm}** vinculado para sincronizar roles. Transcripción guardada en ${entryChannel} y canal de apply eliminado. Canal de raider: ${raiderChannel}.`);
}

async function rejectApplication(interaction) {
  if (!isOfficer(interaction)) return interaction.reply(unauthorizedReply());
  if (!interaction.appPermissions?.has(PermissionFlagsBits.ManageChannels)) {
    return interaction.reply({ content: 'El bot necesita **Gestionar canales** para archivar y eliminar el canal del apply.', flags: MessageFlags.Ephemeral });
  }
  if (interaction.channel?.type !== ChannelType.GuildText) {
    return interaction.reply({ content: 'Ejecuta `/apply-rechazar` dentro del canal de solicitud correspondiente.', flags: MessageFlags.Ephemeral });
  }

  const applicantId = applicationUserId(interaction);
  const applicationTopic = getApplicationTopic(interaction.channel);
  const alreadyRejected = applicationTopic?.status === '-rejected';
  if (!applicantId || applicationTopic?.applicantId !== applicantId || !['open', '-rejected'].includes(applicationTopic?.status)) {
    return applicationMismatchReply(interaction, applicantId || 'desconocido');
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guild = interaction.guild;
  const reason = interaction.isChatInputCommand()
    ? interaction.options.getString('motivo', true).trim()
    : interaction.fields.getTextInputValue('reason').trim();
  if (reason.length < 3) return interaction.editReply('Indica un motivo de al menos 3 caracteres.');
  const applicant = await guild.members.fetch(applicantId);
  const applicationMessages = await interaction.channel.messages.fetch({ limit: 100 });
  let applicationEmbed;
  for (const message of applicationMessages.values()) {
    applicationEmbed = message.embeds.find((embed) => embed.title?.startsWith('Apply · '));
    if (applicationEmbed) break;
  }
  const character = applicationEmbed?.title?.slice('Apply · '.length).trim() || applicant.displayName;
  const realm = applicationEmbed?.fields?.find((field) => field.name === questionLabels[1].slice(0, 256))?.value?.trim() || 'reino';

  let entryChannel;
  try {
    entryChannel = await findEntryChannel(guild);
  } catch (error) {
    return interaction.editReply(`No puedo archivar la solicitud: ${error.message}`);
  }

  const archiveMarker = `apply-rejected-transcript:${interaction.channelId}`;
  const archiveMessages = await entryChannel.messages.fetch({ limit: 100 });
  let archiveMessage = archiveMessages.find((message) => message.content.includes(archiveMarker));
  const filename = `apply-${cleanChannelName(character)}-${cleanChannelName(realm)}-transcripcion.txt`.slice(0, 120);
  if (!archiveMessage) {
    const transcriptMessages = await fetchAllMessages(interaction.channel);
    const transcript = renderTranscript(transcriptMessages, { applicant, character, realm, resolvedBy: interaction.user, outcome: 'Rechazado', reason });
    archiveMessage = await entryChannel.send({
      content: `Solicitud rechazada · ${character} · ${realm}\nCandidato: ${applicant.user.tag}\nPersonaje: ${character} · ${realm}\nOficial: ${interaction.user.tag}\nMotivo: ${reason}\nCanal archivado: ${interaction.channel.name}\n${archiveMarker}`,
      files: [new AttachmentBuilder(Buffer.from(transcript, 'utf8'), { name: filename })],
      allowedMentions: { parse: [] }
    });
  } else if (!archiveMessage.content.includes(`Motivo: ${reason}`)) {
    const transcriptMessages = await fetchAllMessages(interaction.channel);
    const transcript = renderTranscript(transcriptMessages, { applicant, character, realm, resolvedBy: interaction.user, outcome: 'Rechazado', reason });
    const updatedContent = archiveMessage.content
      .replace(/\nMotivo: [^\n]*/g, '')
      .replace(`\n${archiveMarker}`, `\nMotivo: ${reason}\n${archiveMarker}`);
    archiveMessage = await archiveMessage.edit({
      content: updatedContent,
      attachments: [],
      files: [new AttachmentBuilder(Buffer.from(transcript, 'utf8'), { name: filename })],
      allowedMentions: { parse: [] }
    });
  }

  const notifyMarker = `rejection-notified:${interaction.channelId}`;
  const wasNotified = alreadyRejected || archiveMessage.content.includes(notifyMarker);
  if (!wasNotified) {
    const defaultMessage = `Antes de nada, gracias por el apply y por querer contar con nosotros. Se nota cuando alguien aplica con intención, y eso siempre se agradece.

Lo hemos revisado con calma, pero en este momento no podemos incorporarte en el roster. La decisión no es personal; con la composición actual no vemos que podamos incluirte en la raid.

Preferimos ser sinceros desde el principio antes que hacerte entrar sin tenerlo claro y que nadie se sienta a medias.

Aun así, gracias por el interés y por el tiempo que te has tomado. Si más adelante la situación cambia o volvemos a abrir hueco que encaje mejor con tu perfil, podemos volver a hablar sin problema.

Te deseamos que encuentres un grupo donde te sientas cómodo y puedas disfrutar del progreso como toca ⚔️

Un saludo y suerte. 💪`;

    const template = process.env.APPLY_REJECTED_MESSAGE || defaultMessage;
    const message = fillTemplate(template, {
      user: `<@${applicant.id}>`, character, realm, server: guild.name,
      channel: `<#${interaction.channelId}>`, reason: ''
    }).trim();
    try {
      await applicant.send({ content: message, allowedMentions: { users: [applicant.id], roles: [], parse: [] } });
    } catch {
      return interaction.editReply('La transcripción quedó guardada, pero no pude enviar el rechazo por MD (puede tener los MD cerrados). El canal sigue abierto; contacta al candidato o vuelve a intentarlo después de resolverlo.');
    }
    archiveMessage = await archiveMessage.edit({ content: `${archiveMessage.content}\n${notifyMarker}` });
  }

  await interaction.channel.delete(`Apply archivado en ${entryChannel.name}; solicitud rechazada por ${interaction.user.tag}`);
  return interaction.editReply(`Solicitud rechazada. ${wasNotified ? 'El aviso ya se había enviado.' : 'Mensaje enviado por MD.'} Transcripción guardada en ${entryChannel} y canal de apply eliminado.`);
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Whitebird Recruitment conectado como ${readyClient.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.guildId !== guildId) {
      if (interaction.isChatInputCommand() || interaction.isButton() || interaction.isModalSubmit()) {
        return interaction.reply({ content: 'Este bot solo está configurado para su servidor de Whitebird.', flags: MessageFlags.Ephemeral });
      }
      return;
    }

    if (interaction.isButton() && interaction.customId === 'apply:new') {
      const panel = getPanel(guildId);
      if (!panel || panel.message_id !== interaction.message.id) {
        return interaction.reply({ content: 'Este panel ya no está activo. Usa el botón del panel más reciente.', flags: MessageFlags.Ephemeral });
      }
      return interaction.showModal(applyModal());
    }

    if (interaction.isButton() && /^apply:edit-main:\d+$/.test(interaction.customId)) return await openApplicationEdit(interaction);
    if (interaction.isModalSubmit() && /^apply:edit-main-submit:\d+$/.test(interaction.customId)) return await updateApplicationMain(interaction);

    if (interaction.isButton() && /^apply:(accept|reject):\d+$/.test(interaction.customId)) {
      if (interaction.customId.startsWith('apply:accept:')) return await acceptApplication(interaction);
      if (!isOfficer(interaction)) return interaction.reply(unauthorizedReply());
      return interaction.showModal(rejectionReasonModal(applicationUserId(interaction)));
    }

    if (interaction.isModalSubmit() && /^apply:reject-reason:\d+$/.test(interaction.customId)) return await rejectApplication(interaction);
    if (interaction.isModalSubmit() && interaction.customId === 'apply:submit') return await submitApplication(interaction);
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'apply-panel') return await publishApplyPanel(interaction);
    if (interaction.commandName === 'apply-corregir') return await openApplicationEdit(interaction);
    if (interaction.commandName === 'apply-aceptar') return await acceptApplication(interaction);
    if (interaction.commandName === 'apply-rechazar') return await rejectApplication(interaction);
  } catch (error) {
    console.error('Error en flujo de reclutamiento:', error);
    const message = 'Ha ocurrido un error. Avisa a un oficial para que revise el bot.';
    if (interaction.deferred || interaction.replied) await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
    else await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

client.login(token);
