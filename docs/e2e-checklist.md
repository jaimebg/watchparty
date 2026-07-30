# Checklist E2E manual — jbg-watchparty

Preparación: `npm install && npm start`, config con una carpeta que tenga
un MKV multi-audio real y un .srt externo. Anota la URL pública del túnel.

## Básico
- [ ] La biblioteca lista los vídeos agrupados por carpeta con títulos limpios
- [ ] Crear sala navega a /room/<token> y copia el enlace público
- [ ] El enlace público abre la sala desde OTRA red (datos móviles)
- [ ] El invitado entra con su nombre y ve el vídeo en < 15 s
- [ ] Abrir la URL pública sin /room/… y pegar el código de sala entra a la sala

## Sync
- [ ] Pausa desde el host → pausa en el invitado en < 1 s, con mensaje de sistema
- [ ] Play desde el invitado → reanuda en el host
- [ ] La barra de posición se arrastra y la sala salta al soltar (no en cada píxel)
- [ ] «Ir a» y la barra están disponibles para el invitado, no solo para el host
- [ ] «Ir a 1:27:00» desde cualquiera → ambos saltan; vídeo arranca en < 10 s
- [ ] Saltar, esperar a que arranque, y saltar OTRA VEZ a una zona nueva → el
      vídeo aparece en el minuto pedido (antes salía el principio de la película)
- [ ] Tras dos o tres saltos seguidos, imagen y sonido siguen en sincronía
- [ ] «Ir a» hacia atrás a zona ya vista → arranque casi instantáneo (caché)
- [ ] «Ir a» con basura («abc», más allá del final) → aviso, y la sala no se mueve
- [ ] Durante la carga tras un salto, el reloj de sala se congela y no se desincroniza
- [ ] Invitado con red estrangulada → la sala espera como mucho ~20 s y luego sigue
- [ ] Tras 10 min reproduciendo, deriva entre pantallas imperceptible (< 0,5 s)

## Pistas
- [ ] Vídeo con UNA pista de audio → suena, y el selector de audio no aparece
- [ ] Cambiar audio en el invitado NO cambia el audio del host (vídeo multi-audio)
- [ ] Cada selector de subtítulos funciona por espectador (incrustado y .srt externo)
- [ ] Archivo HEVC → transcodifica y reproduce (CPU/GPU visible en monitor)

## Cobertura de la película (lo que rompió la sesión del 29/07/2026)
- [ ] `video.m3u8` lista segmentos hasta el final real: el último `#EXTINF` suma
      la duración completa, no una parte
- [ ] Saltar a 10 min del final y dejarlo correr → llega a los créditos con audio
      y sin que la sala se congele sola

## Chat
- [ ] Mensajes bidireccionales con colores por usuario
- [ ] GIFs: búsqueda y envío (con API key); sin API key el botón no aparece
- [ ] Reacciones flotan sobre el vídeo en ambas pantallas
- [ ] Recargar la página del invitado → reconecta, historial y posición intactos
- [ ] Con el historial desplazado hacia arriba, un GIF nuevo baja la lista al fondo

## Errores
- [ ] Archivo corrupto → la sala muestra error con log y botón reintentar
- [ ] Matar cloudflared a mano → se relanza y loguea nueva URL
- [ ] Cerrar sala (DELETE) → caché de la sala borrada

## Reacciones y emojis
- [ ] Al pulsar un emoji, aparece pequeño junto al nombre de quien lo pulsó, en
      TODAS las pestañas, y desaparece a los ~2,5 s
- [ ] Pulsar dos emojis seguidos reinicia el destello con el segundo
- [ ] Dos invitados con el MISMO nombre: el destello cae en el chip correcto
- [ ] El botón «+» abre el modal; el catálogo carga y se ve la rejilla
- [ ] El modal tiene 9 pestañas de categoría; cambiar de pestaña cambia la
      rejilla de emojis que se muestra
- [ ] Buscar «palomitas» encuentra 🍿; buscar «corazon» sin tilde encuentra corazones
- [ ] Añadir un emoji lo pone al final de la barra y lo deshabilita en la rejilla
- [ ] La ✕ de un chip lo quita de la barra
- [ ] Al llegar a 12 sale el aviso y la rejilla se deshabilita entera
- [ ] Recargar la página conserva la selección; otro navegador tiene la suya

## Pantalla completa
- [ ] El botón de los controles entra y sale de pantalla completa
- [ ] La tecla F entra y sale; escribir una «f» en el chat NO la dispara
- [ ] Ctrl+F (Windows) o Cmd+F (Mac) abre el buscador del navegador; NO entra
      ni sale de pantalla completa
- [ ] Doble clic en el vídeo entra y sale SIN dejar dos mensajes de sistema
- [ ] Tras el doble clic, la película sigue en el mismo estado de play/pausa
      que tenía justo antes (el doble clic no lo cambia)
- [ ] Escape sale de pantalla completa
- [ ] El vídeo llena la pantalla sin recortes; los controles quedan superpuestos
      abajo en una sola fila
- [ ] El chat flota abajo a la derecha, encajado con la barra de reacciones
- [ ] Se puede escribir y hacer scroll en el chat flotante; el buscador de GIFs
      y el modal de emojis se abren y se ven
- [ ] Tras ~3 s sin tocar nada, controles/chat/reacciones se ocultan y el cursor
      desaparece; los emojis volando siguen viéndose
- [ ] Tras ocultarse, mover el ratón hace que controles, chat y reacciones
      vuelvan a aparecer
- [ ] Tras ocultarse, pulsar cualquier tecla también hace que vuelvan a
      aparecer
- [ ] Un mensaje de otra pestaña despierta el chrome SIN tocar el ratón
- [ ] Con el foco en el input del chat, el chrome no se oculta nunca
- [ ] Con la sala en pausa, el chrome no se oculta
- [ ] Escribir algo a medias, entrar y salir de pantalla completa: el texto SIGUE ahí
- [ ] En iPhone el botón activa el «modo cine» (ocupa la ventana, con la barra
      de Safari a la vista) y el chat flotante se ve
