# Verificación Higrotérmica

Cálculo de transmitancia térmica (K) y verificación de riesgo de condensación
superficial e intersticial, según **IRAM 11601 / 11603 / 11605 / 11625** y el
**Código de Edificación de CABA**.

Con usuarios individuales, panel de administración y registro de accesos.

---

## 1. Antes que nada: lo que un HTML no puede hacer solo

Un archivo `.html` abierto en el navegador **no puede ejecutar un servidor**,
ni guardar usuarios, ni registrar quién entró. Todo lo que hace ocurre en la
máquina de cada persona, sin memoria compartida.

Para tener usuarios y control de accesos hace falta un programa corriendo en
algún lado. Eso es `server.js`. Tenés dos formas de ejecutarlo:

- **En tu computadora** (uso propio o en tu red local) → sección 2
- **Publicado en internet**, con su dirección web → sección 3

---

## 2. Ejecutarlo en tu computadora

Necesitás **Node.js 18 o superior** ([nodejs.org](https://nodejs.org)).

```bash
npm install      # solo la primera vez
node server.js
```

Abrí **http://localhost:3000**

La primera vez, la consola muestra el usuario y la contraseña del
administrador. **Anotá esa contraseña**: se genera al azar y no se vuelve a
mostrar.

```
+------------------------------------------------------+
|  PRIMER ARRANQUE - administrador creado               |
+------------------------------------------------------+
|  Usuario:     admin
|  Contrasena:  ab7c0817c3991a
+------------------------------------------------------+
```

Si preferís elegirla vos:

```bash
VH_ADMIN_PASSWORD="TuClave123" node server.js
```

En Windows (PowerShell): `$env:VH_ADMIN_PASSWORD="TuClave123"; node server.js`

---

## 3. Publicarlo en internet

### El problema a resolver primero: dónde viven los usuarios

En 2026, **Render es de las pocas plataformas que todavía da un plan web
gratuito sin límite de tiempo** — y justo por eso **no permite disco
persistente** en ese plan (Railway y Fly.io ya ni siquiera tienen plan
gratuito para cuentas nuevas). Sin disco, todo lo que la app guarde en su
propio sistema de archivos —usuarios, contraseñas, registro de accesos—
**se borra en cada redespliegue**, porque el contenedor se recrea desde cero.

La solución no es resignarse a eso: es sacar esos datos del contenedor y
guardarlos en una base de datos aparte, que sigue viva aunque el servidor web
se reinicie. Esta app ya sabe hacerlo: si definís la variable `DATABASE_URL`,
usa Postgres en vez de archivos locales (ver `store.js`). Sin esa variable,
sigue usando archivos locales como hasta ahora — perfecto para correrlo en tu
computadora o en un Docker con disco real, pero no en Render gratis.

**Neon** ([neon.tech](https://neon.tech)) da un proyecto Postgres gratis
*de forma permanente* (no es una prueba de 30 días): alcanza y sobra para este
uso.

### Paso a paso: Render + Neon (gratis, persistente)

1. **Creá la base en Neon:**
   - Entrá a [neon.tech](https://neon.tech) → cuenta gratis → "New Project".
   - Copiá la cadena de conexión que te muestra (empieza con
     `postgresql://...`, incluye usuario, clave y el nombre de la base).

2. **Subí el proyecto a GitHub.**

3. **En [render.com](https://render.com) → New → Blueprint** → elegí el repo.
   Render lee `render.yaml` y configura casi todo solo.

4. **Variables de entorno** (Render te las pide al crear el Blueprint, o las
   cargás después en el panel del servicio):
   - `DATABASE_URL` → pegá ahí la cadena de conexión de Neon.
   - `VH_ADMIN_PASSWORD` → la clave que quieras para el primer administrador.

5. Listo: `https://tu-app.onrender.com`. La consola del servicio en Render te
   va a mostrar, en el primer arranque, el usuario y clave del administrador
   si no definiste `VH_ADMIN_PASSWORD`.

Si en algún momento sacás `DATABASE_URL`, la app vuelve a usar archivos
locales sin avisar demasiado — por eso, si la desplegás sin esa variable en
un hosting sin disco, el log del servidor te lo advierte apenas arranca.

### Otras opciones

- **Railway / Fly.io / DigitalOcean App Platform**: mismo esquema (`Dockerfile`
  incluido). Ya no tienen plan gratuito indefinido, pero sus planes pagos
  entry-level sí incluyen disco persistente, así que con ellos ni siquiera
  hace falta Postgres externo.
- **Cualquier VPS con Docker** (si tenés uno, o una máquina propia):
  `docker build -t vh . && docker run -p 3000:3000 -v vh_data:/app/data vh`
  — con un volumen real, los archivos locales alcanzan, `DATABASE_URL` es
  opcional.
- **Un servidor propio**: `node server.js` detrás de nginx o Caddy con HTTPS.

### Variables de entorno

| Variable | Para qué sirve |
|---|---|
| `PORT` | Puerto (los hostings lo definen solos) |
| `DATABASE_URL` | Cadena de conexión a Postgres (Neon u otro). Si está definida, se usa en vez de archivos locales |
| `VH_ADMIN_USER` | Nombre del primer administrador (por defecto `admin`) |
| `VH_ADMIN_PASSWORD` | Su contraseña inicial (si no, se genera al azar) |
| `VH_SESSION_SECRET` | **Importante**: sin esto, las sesiones se cierran en cada reinicio |
| `VH_SECURE_COOKIE` | Poner en `1` cuando el sitio use HTTPS |
| `VH_DATA_DIR` | Con backend local: dónde guardar usuarios y registro (por defecto `./data`) |
| `VH_PG_NO_SSL` | Con backend Postgres: poner en `1` solo si tu proveedor no admite TLS (inusual) |

### Una aclaración honesta sobre el backend Postgres

El código que habla con Postgres (`store-pg.js`) se revisó con cuidado —
consultas parametrizadas, sin concatenar datos del usuario en el SQL — pero
este entorno de desarrollo no tiene salida de red hacia servicios externos,
así que no pude probarlo contra un Neon real de punta a punta. El backend de
archivos locales sí está probado así, exhaustivamente. Apenas lo despliegues
con Postgres, probá dar de alta un usuario y loguearte con él antes de
confiar el sistema a uso real; si algo falla, el log del servidor en Render
muestra el error concreto.

---

## 4. Usuarios y permisos

| | Sin sesión | Usuario | Administrador |
|---|:---:|:---:|:---:|
| Diseñar muros, editar capas | Sí | Sí | Sí |
| Calcular K y condensación | Sí | Sí | Sí |
| Visualización 2D y 3D, planilla | Sí | Sí | Sí |
| Exportar a Excel | No | Sí | Sí |
| Generar informes | No | Sí | Sí |
| Exportar diseño | No | Sí | Sí |
| Crear y gestionar usuarios | No | No | Sí |
| Ver el registro de accesos | No | No | Sí |

### Crear usuarios

Entrá como administrador y hacé clic en **Admin** (arriba a la derecha), o
andá directo a `/admin`.

En la pestaña **Usuarios**: "+ Nuevo usuario". Podés generar una contraseña
segura con el botón 🎲. Anotala y entregásela a la persona: **no se puede
volver a ver** (se guarda solo el hash). Si se pierde, la restablecés desde el
mismo panel.

Cada usuario nuevo debe **cambiar su contraseña la primera vez que ingresa**.

### Registro de accesos

En la pestaña **Registro de accesos** ves, con fecha, hora e IP:

- Ingresos correctos y fallidos (y el motivo del fallo)
- Cierres de sesión
- Cada exportación: quién, qué muro, qué proyecto
- Altas, bajas y modificaciones de usuarios
- Intentos de acceso denegados al panel de administración

Se puede filtrar por usuario o tipo de evento, y **descargar en CSV** para
abrirlo en Excel.

---

## 5. Cómo está protegido

- Las contraseñas se guardan como **hash scrypt con sal única por usuario**.
  No se guarda ni se puede recuperar el texto original.
- La sesión es una cookie **HttpOnly firmada con HMAC**: el JavaScript de la
  página no puede leerla ni falsificarla.
- Los archivos **los genera el servidor**, no el navegador. Sin sesión válida
  la respuesta es `401` y no hay archivo: manipular la página no sirve.
- **Bloqueo por intentos**: 5 fallos seguidos bloquean esa cuenta 15 minutos;
  además hay un límite por IP.
- No se puede eliminar ni desactivar al último administrador activo (evita
  quedarse afuera del sistema).

### Lo que conviene tener en cuenta

- **Usá HTTPS sí o sí** si lo publicás. Sin TLS la contraseña viaja en texto
  plano. Con HTTPS, acordate de `VH_SECURE_COOKIE=1`.
- El registro guarda los últimos 5000 eventos; los más viejos se descartan.
  Si necesitás conservarlos, descargá el CSV periódicamente.
- Los datos viven en archivos JSON dentro de `data/`. Funciona bien para
  decenas de usuarios. Para cientos, o si necesitás varias instancias en
  paralelo, habría que pasar a una base de datos.
- El límite por IP vive en memoria y se reinicia con el proceso.

---

## 6. Archivos

```
server.js        servidor: sesiones, permisos y generación de archivos
store.js         elige el backend de almacenamiento (ver abajo)
store-local.js    - backend de archivos JSON (sin DATABASE_URL)
store-pg.js        - backend Postgres (con DATABASE_URL)
public/
  index.html    la aplicación (cálculo, visualización 2D/3D)
  admin.html    panel de administración
data/           con backend local: usuarios y registro (se crea solo; no subir a git)
Dockerfile      para desplegar con Docker
render.yaml     configuración automática para Render
```

Para hacer una copia de seguridad: con backend local, guardá la carpeta
`data/`; con backend Postgres, hacé un `pg_dump` de la base en Neon (o el
proveedor que uses) — es una base de datos como cualquier otra.

---

## 7. Alcance técnico

- Cubre **muros** (cerramientos verticales opacos) en régimen estacionario.
  No cubre techos, pisos, puentes térmicos (IRAM 11630) ni aberturas.
- La tabla de K máximo de invierno cubre TDMN de 0 °C a 15 °C. Climas más
  fríos se saturan en el extremo y deben verificarse contra la norma.
- No modela inercia térmica ni régimen dinámico.
- Los materiales marcados **[ORIENTATIVO]** no provienen de una tabla oficial
  verificada: confirmalos con ensayo IRAM 11559/11564 o ficha del fabricante
  antes de presentar ante el GCBA.
- Es una **herramienta de apoyo al diseño**, no un dictamen de cumplimiento
  normativo.
