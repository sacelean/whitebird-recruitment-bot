import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;
if (!token || !clientId || !guildId) throw new Error('Configura DISCORD_TOKEN, DISCORD_CLIENT_ID y DISCORD_GUILD_ID en .env.');

const commands = [
  new SlashCommandBuilder()
    .setName('apply-panel')
    .setDescription('Publica o actualiza el panel de solicitudes en este canal (oficiales)'),
  new SlashCommandBuilder()
    .setName('apply-aceptar')
    .setDescription('Acepta la solicitud de un miembro y crea su canal privado de raider')
    .addUserOption((option) => option.setName('usuario').setDescription('Persona cuya solicitud se acepta').setRequired(true)),
  new SlashCommandBuilder()
    .setName('apply-rechazar')
    .setDescription('Rechaza una solicitud, avisa al candidato y archiva la transcripción')
    .addUserOption((option) => option.setName('usuario').setDescription('Persona cuya solicitud se rechaza').setRequired(true))
    .addStringOption((option) => option.setName('motivo').setDescription('Motivo opcional que se incluirá en el mensaje al candidato').setMaxLength(500))
].map((command) => command.toJSON());

const rest = new REST({ version: '10' }).setToken(token);
await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
console.log(`Comandos de reclutamiento registrados en el servidor ${guildId}.`);
