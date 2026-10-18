# Ícono de MidatoPay

Pegá aquí el archivo `icon.png`: PNG cuadrado, idealmente 1024 × 1024 px,
con fondo opaco y sin esquinas redondeadas. Mantené el símbolo principal
centrado, dentro del 70 % del ancho, para que funcione con las máscaras de Android.

Ejecutá `npm run icons:generate` para regenerar los PNG de instalación en
`public/icons/`. Si todavía no existe `icon.png`, el generador usa
`public/logo/logo.png` como imagen provisional. Los PNG generados se versionan;
el despliegue no necesita regenerarlos.
