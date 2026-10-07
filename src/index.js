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

const token = process.env.DISCORD_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;
if (!token || !guildId) throw new Error('Configura DISCORD_TOKEN y DISCORD_GUILD_ID en .env.');

const officerRoleIds = new Set((process.env.OFFICER_ROLE_IDS || '').split(',').map((id) => id.trim()).filter(Boolean));
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const questionIds = ['character', 'realm', 'class', 'experience', 'availability'];
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

Pedimos compromiso razonable:
• Avisar asistencias
• Venir preparado
• Conocer las mecánicas
• Y, sobre todo, buena actitud

Aquí nadie es perfecto, pero sí pedimos ganas de mejorar. Morimos, aprendemos, ajustamos… y volvemos a tirar. Sin dramas innecesarios ni gritos por voice.

El ambiente es importante para nosotros. Somos competitivos cuando toca, pero también sabemos reírnos cuando el boss decide que hoy no es el día (porque siempre hay un día así 😏.

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

function wowRealmSlug(value) {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
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

function privateOverwrites(guild, targetId, roles, botId) {
  return [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: targetId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    ...roles.map((role) => ({ id: role.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] })),
    { id: botId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels] }
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
    new ButtonBuilder().setCustomId(`apply:reject:${interaction.user.id}`).setLabel('Rechazar').setStyle(ButtonStyle.Danger)
  );
  try {
    await channel.send({ content, embeds: [embed], components: [decisionButtons], allowedMentions: { users: [interaction.user.id], roles: [], parse: [] } });
  } catch (error) {
    await channel.delete('No se pudo publicar el contenido de la solicitud').catch(() => {});
    throw error;
  }
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
  const guild = interaction.guild;
  const applicant = await guild.members.fetch(applicantId);
  const applicationMessages = await interaction.channel.messages.fetch({ limit: 100 });
  const applicationMessage = applicationMessages.find((message) => message.embeds.some((embed) => embed.title?.startsWith('Apply · ')));
  const applicationEmbed = applicationMessage?.embeds.find((embed) => embed.title?.startsWith('Apply · '));
  const character = applicationEmbed?.title?.slice('Apply · '.length).trim() || applicant.displayName;
  const realm = applicationEmbed?.fields?.find((field) => field.name === questionLabels[1].slice(0, 256))?.value?.trim() || 'reino';
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
      permissionOverwrites: privateOverwrites(guild, applicant.id, roles, botMember.id),
      reason: `Solicitud aceptada por ${interaction.user.tag}`
    });
  } else if (raiderChannel.name !== raiderChannelName) {
    await raiderChannel.setName(raiderChannelName, 'Nombre actualizado al personaje y reino de la solicitud');
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

  await interaction.channel.delete(`Apply archivado en ${entryChannel.name}; solicitud aceptada por ${interaction.user.tag}`);
  const deliveryText = wasNotified ? 'La bienvenida ya se había enviado.' : `Mensaje enviado por ${delivery}.`;
  return interaction.editReply(`Solicitud aceptada. ${deliveryText} Transcripción guardada en ${entryChannel} y canal de apply eliminado. Canal de raider: ${raiderChannel}.`);
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

    if (interaction.isButton() && /^apply:(accept|reject):\d+$/.test(interaction.customId)) {
      if (interaction.customId.startsWith('apply:accept:')) return await acceptApplication(interaction);
      if (!isOfficer(interaction)) return interaction.reply(unauthorizedReply());
      return interaction.showModal(rejectionReasonModal(applicationUserId(interaction)));
    }

    if (interaction.isModalSubmit() && /^apply:reject-reason:\d+$/.test(interaction.customId)) return await rejectApplication(interaction);
    if (interaction.isModalSubmit() && interaction.customId === 'apply:submit') return await submitApplication(interaction);
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'apply-panel') return await publishApplyPanel(interaction);
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
