# Release notes — Whitebird Recruitment Bot

## 2026-11-15 · Rol Recluta al aceptar

- Aceptar un apply asigna inmediatamente el rol Recluta. Si el rol no existe, está duplicado o no es gestionable, se informa del problema; si falla la asignación, el apply permanece abierto para reintentar.

## Próximo lanzamiento · 2026-10-25

### Seguridad

- Actualizada la imagen base de Docker a Node.js **22.23.4** (node:22.23.4-bookworm-slim).
- Incluye las correcciones de seguridad del lanzamiento de Node.js del 21 de octubre de 2026, incluida **CVE-2026-111497** en el decodificador Brotli.
- No cambia el comportamiento funcional del bot.

### Despliegue

Reconstruye la imagen descargando la base actualizada y recrea el contenedor:

```sh
docker compose build --pull
docker compose up -d
docker compose exec bot node -v
```

La última orden debe mostrar `v22.23.4`.

