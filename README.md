# Whitebird Recruitment Bot

Bot independiente para recibir solicitudes de nuevos reclutas y gestionar el paso de solicitud a raider. El bot de roles WoW permanece separado.

## Flujo de solicitud

1. Un oficial usa `/apply-panel` dentro del canal donde quiere publicar el panel. El bot publica el mensaje introductorio y justo debajo el panel; si se vuelve a ejecutar el comando, actualiza esos mensajes sin duplicarlos.
2. El panel muestra el botón **New Apply**. Al pulsarlo, el candidato rellena un formulario privado con cinco respuestas obligatorias:
   - personaje principal;
   - reino;
   - clase y especialización;
   - experiencia en raids;
   - disponibilidad y motivación para entrar en Whitebird.
3. Al enviar, se crea `apply-nombre-del-personaje` dentro de la categoría de solicitudes. Solo el candidato, los roles de `OFFICER_ROLE_IDS` y el bot pueden ver y escribir en ese canal. El bot publica un mensaje de recepción configurable, las respuestas y enlaces de perfil EU a Raider.IO y Warcraft Logs construidos con el personaje y reino indicados.
4. Un oficial ejecuta `/apply-aceptar usuario:@miembro` desde el canal privado correspondiente. El bot manda el mensaje de aceptación por DM (o en el canal privado de raider si la persona tiene los DMs cerrados), guarda una transcripción `.txt` en el canal de entrada y elimina el canal de solicitud solo después de que la transcripción se haya publicado correctamente. También crea `raider-personaje-reino` en la categoría de raiders.
5. Para rechazar, un oficial ejecuta `/apply-rechazar usuario:@miembro` en el canal del apply. Puede añadir el argumento opcional `motivo`; el bot envía el rechazo por DM, archiva la transcripción en el canal de entrada y elimina el canal. Si los MD están cerrados, conserva el canal para que el oficial pueda contactar al candidato y volver a intentarlo.

El panel se publica o actualiza con `/apply-panel`. Solo el último panel registrado acepta nuevos formularios. Una persona con una solicitud abierta no puede crear otra hasta que su canal anterior se cierre. Al aceptar o rechazar, la transcripción se guarda en `ENTRY_CHANNEL_ID` y el canal temporal del apply se elimina; al aceptar, el canal privado de raider se conserva.

## Configuración

1. Crea una aplicación de Discord y un bot en [Discord Developer Portal](https://discord.com/developers/applications). Copia el token y el Application ID.
2. Invita el bot al servidor con scopes `bot` y `applications.commands`, y permisos `View Channels`, `Send Messages`, `Embed Links`, `Read Message History`, `Attach Files` y `Manage Channels`. No concedas Administrador.
3. Copia `.env.example` a `.env`, completa el token, los IDs y las categorías:

```dotenv
DISCORD_TOKEN=...
DISCORD_CLIENT_ID=...
DISCORD_GUILD_ID=...
OFFICER_ROLE_IDS=id_rol_oficial,id_rol_oficial2
APPLY_CATEGORY_ID=id_categoria_applies
RAIDER_CATEGORY_ID=id_categoria_raiders
ENTRY_CHANNEL_ID=id_canal_entrada
```

Activa el modo desarrollador de Discord para copiar IDs. Coloca las categorías, el canal de entrada y los roles dentro del servidor configurado. En el canal de entrada, el bot necesita `View Channels`, `Send Messages`, `Read Message History` y `Attach Files`. Añade todos los roles de oficiales que deban poder ver y hablar en los canales privados.

Los textos de las preguntas y los mensajes predefinidos se pueden cambiar en `.env`. El mensaje de aceptación predeterminado es la bienvenida de Recluta integrada en el bot. Si ya tenías una variable `APPLY_ACCEPTED_MESSAGE` en `.env` con el texto anterior, elimínala para usar la bienvenida nueva. El mensaje de rechazo también se puede personalizar con `APPLY_REJECTED_MESSAGE`. Los marcadores disponibles son `{user}`, `{character}`, `{realm}`, `{server}`, `{channel}` y, para rechazo, `{reason}`.

## Despliegue con Docker Compose

Desde este directorio, en Ubuntu:

```sh
cp .env.example .env
# Edita .env y completa todos los valores.
mkdir -p data
docker compose run --rm bot npm run register
docker compose up -d --build
docker compose logs -f bot
```

Cuando añadas o cambies comandos, vuelve a ejecutar `docker compose run --rm bot npm run register` para registrarlos en Discord.

La base `data/whitebird-recruitment.sqlite` conserva cuál es el último panel. El archivo `compose.yaml` monta `data/` para mantener esa información aunque se reemplace el contenedor. Para actualizar, haz una copia de `data/` y ejecuta:

```sh
docker compose build
docker compose run --rm bot npm run register
docker compose up -d
docker compose logs -f bot
```

## Ejecución directa con Node.js

Requiere Node.js 20.11 o posterior:

```sh
cp .env.example .env
# Edita .env
npm install
npm run register
npm start
```

Este bot no necesita credenciales de Blizzard ni permisos para gestionar roles de Discord. Las personas con permiso Administrador siempre pueden acceder a cualquier canal del servidor, aunque no estén en los overwrites privados.
