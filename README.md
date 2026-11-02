# Whitebird Recruitment Bot

[Release notes](RELEASE_NOTES.md)

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
   En el mensaje principal del apply aparecen los botones **Aceptar**, **Rechazar** y **Corregir main/reino**. Aceptar y rechazar son acciones exclusivas de oficiales. El candidato o un oficial pueden corregir el personaje y reino mientras la solicitud siga abierta; el bot actualiza la ficha, enlaces y nombre del canal, y deja un registro del cambio en el historial. También se puede abrir el formulario con `/apply-corregir`, útil para solicitudes que ya estaban abiertas antes de instalar los botones. El botón de rechazo abre un formulario que exige el motivo y lo guarda en la transcripción para los oficiales; no se envía al candidato. Los comandos de aceptar y rechazar se ejecutan dentro del canal, sin seleccionar al usuario.
4. Un oficial ejecuta `/apply-aceptar` desde el canal privado correspondiente. El bot identifica al candidato por el canal, vincula el personaje principal, el reino corregido y el ID de su canal privado de Raider con su cuenta de Discord en la base compartida del bot de sync, crea `raider-personaje-reino`, añade el bot de sync a sus permisos y publica allí un mensaje de bienvenida. El bot de sync puede ver, escribir y renombrar ese canal. También manda el mensaje de aceptación por DM (o en el canal privado de raider si la persona tiene los DMs cerrados), guarda una transcripción `.txt` en el canal de entrada y elimina el canal de solicitud solo después de guardar el vínculo y la transcripción.
5. Para rechazar, un oficial ejecuta `/apply-rechazar motivo:...` en el canal del apply. El bot identifica al candidato por el canal, envía el mensaje de rechazo por DM sin incluir el motivo, archiva la transcripción con el motivo en el canal de entrada y elimina el canal. Si los MD están cerrados, conserva el canal para que el oficial pueda contactar al candidato y volver a intentarlo.

El panel se publica o actualiza con `/apply-panel`. Solo el último panel registrado acepta nuevos formularios. Una persona con una solicitud abierta no puede crear otra hasta que su canal anterior se cierre. Al aceptar o rechazar, la transcripción se guarda en `ENTRY_CHANNEL_ID` y el canal temporal del apply se elimina; al aceptar, el canal privado de raider se conserva.

La ficha del apply consulta el perfil público de Raider.IO para añadir nivel de objeto, progreso de raid, kills por dificultad, puntuación y mejor M+, y puntos de logro. La consulta usa región EU y no requiere credenciales. Si Raider.IO no encuentra el personaje, limita la petición o no responde, el apply se crea igualmente y las estadísticas aparecen como no disponibles. El botón **Corregir main/reino** vuelve a consultar y actualizar estas estadísticas. El embed mantiene el enlace al perfil de Raider.IO como atribución.

## Configuración

1. Crea una aplicación de Discord y un bot en [Discord Developer Portal](https://discord.com/developers/applications). Copia el token y el Application ID.
2. Invita el bot al servidor con scopes `bot` y `applications.commands`, y permisos `View Channels`, `Send Messages`, `Embed Links`, `Read Message History`, `Attach Files`, `Manage Channels`, `Manage Roles` y `View Audit Log` (**Ver registro de auditoría**). No concedas Administrador.
3. En Developer Portal → aplicación → **Bot** → **Privileged Gateway Intents**, activa **Message Content Intent**. Es necesario para que el bot pueda leer en las transcripciones el texto de mensajes enviados por candidatos y oficiales. El código también debe iniciar con `GatewayIntentBits.MessageContent`.
4. Copia `.env.example` a `.env`, completa el token, los IDs y las categorías:

```dotenv
DISCORD_TOKEN=...
DISCORD_CLIENT_ID=...
DISCORD_GUILD_ID=...
OFFICER_ROLE_IDS=id_rol_oficial,id_rol_oficial2
APPLY_CATEGORY_ID=id_categoria_applies
RAIDER_CATEGORY_ID=id_categoria_raiders
ENTRY_CHANNEL_ID=id_canal_entrada
# Ruta absoluta a la carpeta data que el bot de sync monta como /app/data
WOW_ROLE_SYNC_DATA_DIR=/home/ubuntu/whitebird-wow-role-sync/data
WOW_ROLE_SYNC_BOT_ID=id_usuario_del_bot_de_sync
```

Activa el modo desarrollador de Discord para copiar IDs. `WOW_ROLE_SYNC_BOT_ID` es el ID de usuario del bot de WoW Role Sync (puedes copiarlo con clic derecho sobre el bot en el servidor). Coloca las categorías, el canal de entrada y los roles dentro del servidor configurado. En el canal de entrada, el bot necesita `View Channels`, `Send Messages`, `Read Message History` y `Attach Files`. Añade todos los roles de oficiales que deban poder ver y hablar en los canales privados.

Para que `/apply-aceptar` pueda dar acceso al bot de sync en el canal Raider, el rol de **Whitebird Apply** necesita `Manage Roles` y `Manage Channels`, y debe estar por encima del rol más alto de **Whitebird Role Sync** en Ajustes del servidor → Roles. Aplica estos permisos solo al bot de Apply; no uses `Administrator`.

Para instalaciones existentes, activa también **Ver registro de auditoría** en Ajustes del servidor → Roles → **Whitebird Apply** → Permisos. Este permiso permite consultar quién creó un canal o modificó sus permisos para diagnosticar incidencias. Es un permiso de servidor; no se configura en los permisos privados de cada canal. No requiere reiniciar el bot y no añade consultas automáticas de auditoría al flujo de aceptación.

Los textos de las preguntas y los mensajes predefinidos se pueden cambiar en `.env`. El mensaje de aceptación predeterminado es la bienvenida de Recluta integrada en el bot. Si ya tenías una variable `APPLY_ACCEPTED_MESSAGE` en `.env` con el texto anterior, elimínala para usar la bienvenida nueva. El mensaje de rechazo también se puede personalizar con `APPLY_REJECTED_MESSAGE`. Los marcadores disponibles son `{user}`, `{character}`, `{realm}`, `{server}` y `{channel}`. El motivo obligatorio de rechazo solo se incluye en la transcripción y no se manda por MD.

Para vincular mains automáticamente al aceptar applies, `WOW_ROLE_SYNC_DATA_DIR` debe apuntar a la carpeta `data` del proyecto de sync que el contenedor monta como `/app/data` (ajusta el ejemplo a la ruta real de tu servidor). Ambos bots accederán a `whitebird-wow-roles.sqlite` en esa carpeta compartida. El bot de sync debe usar su ruta predeterminada `/app/data/whitebird-wow-roles.sqlite`; si configuraste `DATABASE_PATH`, configura el mismo archivo en el bot de apply. La base compartida conserva también el ID del canal privado de Raider, que `/wow-vinculaciones` muestra como enlace al canal. Tras aceptar, `/syncwow` o el siguiente ciclo automático asignará los roles. Si el personaje ya está vinculado a otra cuenta, la restricción única protege el vínculo existente y la aceptación no borrará el canal.

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

Cuando añadas o cambies comandos, vuelve a ejecutar `docker compose run --rm bot npm run register` para registrarlos en Discord. En esta actualización, hazlo para registrar `/apply-corregir` y los comandos de aceptar y rechazar sin opción de usuario.

La base `data/whitebird-recruitment.sqlite` conserva cuál es el último panel. El archivo `compose.yaml` monta `data/` para mantener esa información aunque se reemplace el contenedor. Para actualizar, haz una copia de `data/` y ejecuta:

```sh
docker compose build
docker compose run --rm bot npm run register
docker compose up -d
docker compose logs -f bot
```

## Despliegue automático con GitHub Actions

El workflow `.github/workflows/deploy.yml` construye la imagen, comprueba la sintaxis de JavaScript y verifica que SQLite puede abrir una base en memoria en cada pull request y push a `main`, sin credenciales de producción. Si las comprobaciones pasan, los pushes a `main` despliegan en OCI por SSH. También puedes ejecutarlo desde **Actions → Check and deploy to OCI → Run workflow**, seleccionando `main`. Los despliegues se ejecutan de uno en uno.

El despliegue sincroniza el código, construye la imagen, registra los comandos de Discord y recrea el servicio `bot`. Solo termina correctamente cuando el contenedor sigue ejecutándose sin reinicios y anuncia su conexión a Discord. Si falla, revisa los logs de Actions y `docker compose logs bot` en el servidor.

### Preparación del servidor (una vez)

Usa una carpeta dedicada exclusivamente a este repositorio, con `.env` configurado y `data/` con permisos de escritura para UID 1000. `WOW_ROLE_SYNC_DATA_DIR` debe apuntar a la carpeta de datos existente del bot de sync, fuera de esta carpeta de despliegue.

El usuario SSH necesita permisos para escribir en la carpeta y ejecutar Docker y Compose v2 sin sudo ni preguntas interactivas. El servidor necesita Bash, rsync y flock (util-linux), y debe aceptar conexiones SSH desde los runners de GitHub.

```sh
cd /home/ubuntu/whitebird-recruitment-bot
# Completa antes .env y prepara data/ con permisos para UID 1000.
test -f .env && test -d data && touch .allow-github-deploy
chmod 600 .env
docker compose config --quiet
```

El marcador `.allow-github-deploy` autoriza la sincronización en esa ruta. Se usa `rsync --delete`: se conservan `.git/`, `.env`, `data/`, `node_modules/`, `.deploy.lock` y `.allow-github-deploy`, pero se eliminan otros archivos que no estén en el repositorio. Guarda copias de seguridad y otros proyectos fuera de esa carpeta. La base compartida del bot de sync permanece en su ruta externa.

Crea una clave SSH de despliegue sin contraseña y añade su clave pública a `~/.ssh/authorized_keys` del usuario del servidor.

### Secrets en GitHub

En **Settings → Secrets and variables → Actions → Repository secrets**, configura:

| Secret | Valor |
|---|---|
| `OCI_HOST` | IP o hostname del servidor OCI. |
| `OCI_USER` | Usuario SSH, por ejemplo `ubuntu`. |
| `OCI_SSH_KEY` | Clave privada de despliegue completa, con sus saltos de línea. |
| `OCI_KNOWN_HOSTS` | Entrada SSH verificada del servidor. |
| `OCI_DEPLOY_PATH` | Ruta absoluta exclusiva del bot, por ejemplo `/home/ubuntu/whitebird-recruitment-bot`. |
| `OCI_SSH_PORT` | Opcional; por defecto `22`. |

Puedes reutilizar los valores de conexión del bot de sync, pero `OCI_DEPLOY_PATH` debe apuntar a este bot. La ruta admite letras, números, guiones y guiones bajos, sin barra final. Para obtener `OCI_KNOWN_HOSTS`, ejecuta `ssh-keyscan -p 22 -H HOST` desde un equipo de confianza y verifica la huella con la consola de OCI (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`) antes de guardar la entrada. Ajusta el puerto si corresponde.

Las credenciales de Discord y la configuración del bot permanecen en el `.env` del servidor.

## Ejecución directa con Node.js

Requiere Node.js 20.11 o posterior:

```sh
cp .env.example .env
# Edita .env
npm install
npm run register
npm start
```

Este bot no necesita credenciales de Blizzard. Necesita `Manage Roles` para configurar los permisos de los canales privados. Las personas con permiso Administrador siempre pueden acceder a cualquier canal del servidor, aunque no estén en los overwrites privados.
