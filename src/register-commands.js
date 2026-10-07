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
    .setName('apply-corregir')
    .setDescription('Corrige el personaje principal o reino del apply en este canal'),
  new SlashCommandBuilder()
    .setName('apply-aceptar')
    .setDescription('Acepta la solicitud del canal actual y crea su canal privado de raider'),
  new SlashCommandBuilder()
    .setName('apply-rechazar')
    .setDescription('Rechaza la solicitud del canal actual y archiva la transcripción')
    .addStringOption((option) => option.setName('motivo').setDescription('Motivo que se guardará en la transcripción para los oficiales').setMinLength(3).setMaxLength(500).setRequired(true))
].map((command) => command.toJSON());

const rest = new REST({ version: '10' }).setToken(token);
await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
console.log(`Comandos de reclutamiento registrados en el servidor ${guildId}.`);
