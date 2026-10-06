# Whitebird Recruitment Bot

Bot independiente para recibir solicitudes de nuevos reclutas y gestionar el paso de solicitud a raider. El bot de roles WoW permanece separado.

## Flujo de solicitud

1. Un oficial usa `/apply-panel` dentro del canal donde quiere publicar el panel.
2. El panel muestra el botón **New Apply**. Al pulsarlo, el candidato rellena un formulario privado con cinco respuestas obligatorias:
   - personaje principal;
   - reino;
   - clase y especialización;
   - experiencia en raids;
   - disponibilidad y motivación para entrar en Whitebird.
3. Al enviar, se crea `apply-nombre-del-personaje` dentro de la categoría de solicitudes. Solo el candidato, los roles de `OFFICER_ROLE_IDS` y el bot pueden ver y escribir en ese canal. El bot publica un mensaje de recepción configurable junto con las respuestas.
4. Un oficial ejecuta `/apply-aceptar usuario:@miembro` desde el canal privado correspondiente. El bot manda el mensaje de aceptación por DM (o lo publica allí si la persona tiene los DMs cerrados), bloquea la escritura del candidato en el canal de solicitud y crea `raider-nombre` en la categoría de raiders.

El panel se publica o actualiza con `/apply-panel`. Solo el último panel registrado acepta nuevos formularios. Una persona con una solicitud abierta no puede crear otra hasta que su canal anterior se cierre. El canal aceptado se conserva como historial; el candidato puede leerlo, pero ya no escribir, crear hilos ni reaccionar.

## Configuración

1. Crea una aplicación de Discord y un bot en [Discord Developer Portal](https://discord.com/developers/applications). Copia el token y el Application ID.
2. Invita el bot al servidor con scopes `bot` y `applications.commands`, y permisos `View Channels`, `Send Messages` y `Manage Channels`. No concedas Administrador.
3. Copia `.env.example` a `.env`, completa el token, los IDs y las categorías:

```dotenv
DISCORD_TOKEN=...
DISCORD_CLIENT_ID=...
DISCORD_GUILD_ID=...
OFFICER_ROLE_IDS=id_rol_oficial,id_rol_oficial2
APPLY_CATEGORY_ID=id_categoria_applies
RAIDER_CATEGORY_ID=id_categoria_raiders
```

Activa el modo desarrollador de Discord para copiar IDs. Coloca las categorías y los roles dentro del servidor configurado. El bot necesita acceso a ambas categorías. Añade todos los roles de oficiales que deban poder ver y hablar en los canales privados.

Los textos de las preguntas y los mensajes predefinidos se pueden cambiar en `.env`. El formulario tiene cinco preguntas obligatorias (límite de los modales de Discord). Los marcadores disponibles en los mensajes son `{user}`, `{character}`, `{realm}`, `{server}` y `{channel}`.

## Despliegue con Docker Engine (sin Compose)

Desde este directorio, en Ubuntu:

```sh
cp .env.example .env
# Edita .env y completa todos los valores.
mkdir -p data
docker build -t whitebird-recruitment-bot .
docker run --rm --env-file .env whitebird-recruitment-bot npm run register
docker run -d --name whitebird-recruitment-bot --restart unless-stopped --env-file .env -v "$(pwd)/data:/app/data" whitebird-recruitment-bot
docker logs -f whitebird-recruitment-bot
```

La base `data/whitebird-recruitment.sqlite` conserva cuál es el último panel. Para actualizar, haz una copia de `data/`, detén y elimina el contenedor anterior, reconstruye la imagen, registra de nuevo los comandos y arranca el contenedor.

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
