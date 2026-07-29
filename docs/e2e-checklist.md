# Checklist E2E manual — jbg-watchparty

Preparación: `npm install && npm start`, config con una carpeta que tenga
un MKV multi-audio real y un .srt externo. Anota la URL pública del túnel.

## Básico
- [ ] La biblioteca lista los vídeos agrupados por carpeta con títulos limpios
- [ ] Crear sala navega a /room/<token> y copia el enlace público
- [ ] El enlace público abre la sala desde OTRA red (datos móviles)
- [ ] El invitado entra con su nombre y ve el vídeo en < 15 s

## Sync
- [ ] Pausa desde el host → pausa en el invitado en < 1 s, con mensaje de sistema
- [ ] Play desde el invitado → reanuda en el host
- [ ] Seek a mitad de peli → ambos saltan; vídeo arranca en < 10 s
- [ ] Seek hacia atrás a zona ya vista → arranque casi instantáneo (caché)
- [ ] Tras 10 min reproduciendo, deriva entre pantallas imperceptible (< 0,5 s)

## Pistas
- [ ] Cambiar audio en el invitado NO cambia el audio del host
- [ ] Cada selector de subtítulos funciona por espectador (incrustado y .srt externo)
- [ ] Archivo HEVC → transcodifica y reproduce (CPU/GPU visible en monitor)

## Chat
- [ ] Mensajes bidireccionales con colores por usuario
- [ ] GIFs: búsqueda y envío (con API key); sin API key el botón no aparece
- [ ] Reacciones flotan sobre el vídeo en ambas pantallas
- [ ] Recargar la página del invitado → reconecta, historial y posición intactos

## Errores
- [ ] Archivo corrupto → la sala muestra error con log y botón reintentar
- [ ] Matar cloudflared a mano → se relanza y loguea nueva URL
- [ ] Cerrar sala (DELETE) → caché de la sala borrada
