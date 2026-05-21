# Prospector CRM v2 — Guía completa de setup

## Archivos del proyecto

```
prospector-v2/
├── index.html          ← App principal (PWA)
├── manifest.json       ← Configuración PWA
├── vercel.json         ← Config de deploy + cron jobs
├── api/
│   ├── webhook.js      ← Bot WhatsApp (serverless function)
│   └── scraper-cron.js ← Scraper automático semanal
└── README.md
```

---

## PASO 1 — Crear repo en GitHub

```bash
# Opción A: desde terminal
git init
git add .
git commit -m "Prospector CRM v2"
git remote add origin https://github.com/TU-USUARIO/prospector.git
git push -u origin main

# Opción B: subir los archivos directo desde github.com
# New repository → subir archivos → commit
```

---

## PASO 2 — Deploy en Vercel (OBLIGATORIO para el bot)

El bot de WhatsApp necesita una URL pública con HTTPS. Vercel lo da gratis.

```bash
# Instalar Vercel CLI
npm install -g vercel

# Deploy (desde la carpeta del proyecto)
vercel deploy

# O conectar desde vercel.com → Import Git Repository
```

Tu URL quedará tipo: `https://prospector-abc123.vercel.app`

### Variables de entorno en Vercel

En vercel.com → tu proyecto → Settings → Environment Variables, agregá:

| Variable | Valor | Descripción |
|---|---|---|
| `CLAUDE_API_KEY` | `sk-ant-...` | Claude API Key |
| `WA_ACCESS_TOKEN` | `EAAxxxx...` | WhatsApp Access Token |
| `WA_PHONE_ID_NIVIKO` | `1234567890` | Phone Number ID de NIVIKO |
| `WA_PHONE_ID_BROKER` | `0987654321` | Phone Number ID de Broker (si tenés 2 números) |
| `WA_VERIFY_TOKEN` | `mi_token_secreto` | Token que inventás vos (cualquier string) |
| `VENDEDOR_WA_PHONE` | `5491112345678` | Teléfono del vendedor para escalado |
| `GOOGLE_MAPS_KEY` | `AIza...` | Google Maps API Key |

---

## PASO 3 — Claude API

1. Ir a **console.anthropic.com**
2. Crear cuenta (si no tenés)
3. API Keys → **Create Key**
4. Copiar la key (empieza con `sk-ant-`)
5. Pegarla en **Configuración → Claude API** dentro de la app
6. También agregarla en Vercel como `CLAUDE_API_KEY`

**Costo estimado:** menos de $5 USD/mes con uso normal.

---

## PASO 4 — Google Maps Places API

1. Ir a **console.cloud.google.com**
2. Seleccionar o crear un proyecto
3. APIs & Services → Library → buscar **"Places API"** → Enable
4. APIs & Services → **Credentials** → Create Credentials → API Key
5. Restringir la key: Application restrictions → HTTP referrers → agregar tu dominio
6. Copiar la key y pegarla en **Configuración → Google Maps**

**Costo:** $200 de crédito gratuito por mes. Con búsquedas normales no vas a pagar nada.

---

## PASO 5 — WhatsApp Business API (Meta) — Paso a paso completo

### 5.1 Crear la app en Meta for Developers

1. Ir a **developers.facebook.com**
2. Iniciar sesión con tu cuenta de Facebook
3. **My Apps → Create App**
4. Tipo: **Business**
5. Nombre: "Prospector NIVIKO" (o el que quieras)
6. Business Account: seleccionar o crear tu cuenta de Business Manager

### 5.2 Agregar WhatsApp

1. En tu app → **Add Product → WhatsApp → Set Up**
2. Vas a ver la pantalla de Getting Started

### 5.3 Obtener las credenciales

En **WhatsApp → Getting Started**:
- Copiá el **Phone Number ID** (número largo tipo `123456789012345`)
- Generá un **Temporary Access Token** (dura 24hs, sirve para probar)

Para token permanente:
1. Business Settings → **System Users** → Add
2. Asignar rol: Admin
3. **Generate New Token** → seleccionar tu app
4. Permisos necesarios: `whatsapp_business_messaging`, `whatsapp_business_management`
5. Ese token es el que va en `WA_ACCESS_TOKEN`

### 5.4 Configurar el Webhook

1. En tu app → **WhatsApp → Configuration → Webhook**
2. Click **Edit**
3. **Callback URL:** `https://TU-PROYECTO.vercel.app/api/webhook`
4. **Verify Token:** el mismo que pusiste en Vercel como `WA_VERIFY_TOKEN`
5. Click **Verify and Save**
6. Una vez verificado → **Subscribe** a `messages`

### 5.5 Agregar número de teléfono de producción

Para el sandbox de prueba Meta te da un número gratuito.
Para usar tu propio número:
1. WhatsApp → **Phone Numbers → Add Phone Number**
2. Verificar el número con SMS o llamada
3. Completar el Business Verification de Meta (puede tardar 1-3 días)

### 5.6 Probar que funciona

Desde la pantalla de Getting Started podés enviar un mensaje de prueba a tu propio teléfono.

---

## PASO 6 — Firebase Firestore (opcional, para sync entre dispositivos)

Sin Firebase los datos se guardan en localStorage del navegador (solo en ese dispositivo).
Con Firebase se sincronizan entre todos los dispositivos.

1. Ir a **console.firebase.google.com**
2. Create Project → nombre: `prospector-crm`
3. **Firestore Database** → Create database → Start in **test mode**
4. Project Settings → General → **Your Apps** → Web → Register app
5. Copiar el config JSON completo que se ve así:
```json
{
  "apiKey": "AIzaXXXX",
  "authDomain": "prospector-crm.firebaseapp.com",
  "projectId": "prospector-crm",
  "storageBucket": "prospector-crm.appspot.com",
  "messagingSenderId": "123456",
  "appId": "1:123456:web:abcdef"
}
```
6. Pegarlo en **Configuración → Firebase** dentro de la app

---

## Importar Excels de clientes

La app soporta importación directa de:
- **.xlsx** (Excel)
- **.xls** (Excel antiguo)
- **.csv** (cualquier separador)

### Columnas que reconoce automáticamente:

| Si tu columna se llama... | Se mapea a |
|---|---|
| Empresa, Nombre, Negocio, Razón social | Nombre |
| Teléfono, Phone, Celular, WhatsApp, Tel | Teléfono |
| Mail, Email, Correo | Email |
| Instagram, IG | Instagram |
| Zona, Barrio, Ciudad, Localidad | Zona |
| Rubro, Categoría, Tipo | Rubro |
| Estado, Status | Estado |
| Notas, Observaciones, Comentarios | Notas |

Si los nombres de columna son distintos, podés mapearlo manualmente antes de importar.
Los duplicados (mismo nombre de empresa) se detectan y se omiten automáticamente.

---

## Reportes y exportación

Desde la sección Reportes podés:
- **Exportar a Excel (.xlsx)** — todos los prospectos con sus datos
- **Exportar a CSV** — formato universal
- **Exportar a PDF** — usa la función de impresión del navegador

Los reportes incluyen:
- Pipeline por estado (gráfico de barras)
- Distribución por rubro (dona)
- Actividad de los últimos 7 días (línea)
- Canales de contacto usados (torta)
- Resumen ejecutivo con métricas clave

---

## Cómo funciona el bot

1. El prospecto responde tu mensaje inicial en WhatsApp
2. Meta envía el mensaje a tu webhook en Vercel (`/api/webhook`)
3. El webhook llama a Claude API con la personalidad configurada + historial de la conversación
4. Claude genera una respuesta en 0.8-2 segundos (delay simulado = más humano)
5. El webhook envía la respuesta vía WhatsApp Business API
6. Si Claude detecta que hay que escalar → notifica al vendedor con resumen

### Personalidades disponibles:
- **Lucía (NIVIKO):** cálida, directa, sin vueltas
- **Martín (Broker):** profesional, técnico, orientado a obras
- **Custom:** escribís tu propio prompt de personalidad

---

## Costos mensuales estimados

| Servicio | Free tier | Costo con uso normal |
|---|---|---|
| Claude API | $5 crédito inicial | <$5/mes (300 msgs/mes) |
| Google Maps | $200 crédito/mes | $0 (scraping normal) |
| WhatsApp Business | 1.000 conv/mes | $0 hasta 1.000 |
| Firebase | 50k lecturas/día | $0 |
| Vercel | 100GB bandwidth | $0 |
| GitHub Pages | Ilimitado | $0 |
| **Total estimado** | | **$0 - $10 USD/mes** |
