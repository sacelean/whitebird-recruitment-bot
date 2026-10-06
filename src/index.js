import 'dotenv/config';
import {
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
  if (previous?.channel_id === interaction.channelId) {
    const oldMessage = await interaction.channel.messages.fetch({ message: previous.message_id, force: true }).catch(() => null);
    if (oldMessage) {
      try {
        await oldMessage.edit(applyPanelPayload());
        return interaction.editReply('He actualizado el panel de applies en este canal.');
      } catch (error) {
        if (error?.code !== 10008) throw error;
        console.warn(`El panel guardado ${previous.message_id} ya no existe; se publicará uno nuevo.`);
      }
    }
  }
  const message = await interaction.channel.send(applyPanelPayload());
  savePanel(guildId, interaction.channelId, message.id);
  return interaction.editReply(`Panel de applies publicado en ${interaction.channel}.`);
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
    .addFields(answers.map((value, index) => ({ name: questionLabels[index].slice(0, 256), value: value.slice(0, 1024) })));
  const template = process.env.APPLY_RECEIVED_MESSAGE || '¡Hola {user}! Hemos recibido tu apply para **{character}** · **{realm}**. Los oficiales de Whitebird lo revisarán aquí.';
  const content = fillTemplate(template, {
    user: `<@${interaction.user.id}>`,
    character: values.character,
    realm: values.realm,
    server: interaction.guild.name,
    channel: `<#${channel.id}>`
  });
  try {
    await channel.send({ content, embeds: [embed], allowedMentions: { users: [interaction.user.id], roles: [], parse: [] } });
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
  const applicantUser = interaction.options.getUser('usuario', true);
  const openTopic = `whitebird-apply:${guildId}:${applicantUser.id}`;
  if (interaction.channel.topic !== openTopic) {
    return interaction.reply({ content: 'Este canal no es la solicitud abierta de ese usuario.', flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guild = interaction.guild;
  const applicant = await guild.members.fetch(applicantUser.id);
  const { category, roles, botMember } = await getPrivateChannelSetup(guild, 'RAIDER_CATEGORY_ID');
  const raiderTopic = `whitebird-raider:${guildId}:${applicant.id}`;
  let raiderChannel = guild.channels.cache.find((channel) => channel.type === ChannelType.GuildText && channel.topic === raiderTopic);
  if (!raiderChannel) {
    raiderChannel = await guild.channels.create({
      name: `raider-${cleanChannelName(applicant.displayName)}-${applicant.id.slice(-4)}`.slice(0, 100),
      type: ChannelType.GuildText,
      parent: category.id,
      topic: raiderTopic,
      permissionOverwrites: privateOverwrites(guild, applicant.id, roles, botMember.id),
      reason: `Solicitud aceptada por ${interaction.user.tag}`
    });
  }

  const template = process.env.APPLY_ACCEPTED_MESSAGE || '¡Enhorabuena, {user}! Tu solicitud ha sido aceptada. Tu canal privado de raider es {channel}.';
  const message = fillTemplate(template, {
    user: `<@${applicant.id}>`,
    character: applicant.displayName,
    realm: '',
    server: guild.name,
    channel: `<#${raiderChannel.id}>`
  });
  let delivery = 'mensaje directo';
  try {
    await applicant.send({ content: message, allowedMentions: { users: [applicant.id], roles: [], parse: [] } });
  } catch {
    delivery = 'canal de solicitud';
    await interaction.channel.send({ content: message, allowedMentions: { users: [applicant.id], roles: [], parse: [] } });
  }

  await interaction.channel.permissionOverwrites.edit(applicant.id, {
    SendMessages: false,
    SendMessagesInThreads: false,
    CreatePublicThreads: false,
    CreatePrivateThreads: false,
    AddReactions: false
  }, { reason: `Solicitud aceptada; canal cerrado por ${interaction.user.tag}` });
  await interaction.channel.setTopic(`whitebird-apply-closed:${guildId}:${applicant.id}`);
  return interaction.editReply(`Solicitud aceptada. Mensaje enviado por ${delivery}; canal de solicitud cerrado y canal de raider creado: ${raiderChannel}.`);
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

    if (interaction.isModalSubmit() && interaction.customId === 'apply:submit') return await submitApplication(interaction);
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'apply-panel') return await publishApplyPanel(interaction);
    if (interaction.commandName === 'apply-aceptar') return await acceptApplication(interaction);
  } catch (error) {
    console.error('Error en flujo de reclutamiento:', error);
    const message = 'Ha ocurrido un error. Avisa a un oficial para que revise el bot.';
    if (interaction.deferred || interaction.replied) await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
    else await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

client.login(token);
