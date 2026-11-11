# Scalping (copia que funciona en la nube)

Esta carpeta es una copia del bot de scalping (carpeta `tanatabot-scalping` del ordenador, donde están el laboratorio y las pruebas).
Funciona dentro del mismo bucle de GitHub Actions que Tanatabot, cada 15 minutos, aunque el ordenador esté apagado:
usa el mismo token del bot y envía al grupo "Tanatabot Scalping" (`scalp_config.json`). Su estado va en `scalp_state.json`.
Si se cambia la estrategia en `tanatabot-scalping`, hay que copiar aquí `lab.ts`, `lab_top50.ts` y `scalp.ts`.
