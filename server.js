const express = require('express');
const cors    = require('cors');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3000;

// ===================== CONFIGURACIÓN =====================

const ALLOWED_ORIGINS = [
  'http://127.0.0.1:5500',
  'http://localhost:5500',

  'https://lobo24-9e46b.web.app',
  'https://lobo24-9e46b.firebaseapp.com',

  'https://marketlobo24.com.ar',
  'https://www.marketlobo24.com.ar',

  // sistema-ventas (el POS del local, otro proyecto) — solo para llamar a
  // /sincronizar-stock-pos.
  'https://sistema-ventas-76350.web.app',
  'https://sistema-ventas-76350.firebaseapp.com'
];

app.use(cors({
  origin: function (origin, callback) {

    // Permitir requests sin origin (MercadoPago/webhooks)
    if (!origin) {
      return callback(null, true);
    }

    if (ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }

    console.log('❌ CORS bloqueado:', origin);

    return callback(new Error('No permitido por CORS'));
  },

  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// ===================== MERCADO PAGO =====================

const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');

const mpClient = new MercadoPagoConfig({
    accessToken: process.env.MP_ACCESS_TOKEN
});

// ===================== BREVO (emails) =====================

const SibApiV3Sdk = require('sib-api-v3-sdk');
const brevoClient = SibApiV3Sdk.ApiClient.instance;
brevoClient.authentications['api-key'].apiKey = process.env.BREVO_API_KEY;

const brevoApi = new SibApiV3Sdk.TransactionalEmailsApi();

const SELLER_EMAIL     = process.env.SELLER_EMAIL     || 'marketlobo24@gmail.com';
const FROM_EMAIL       = process.env.BREVO_SENDER_EMAIL || 'onboarding@resend.dev';
const FROM_NAME        = process.env.BREVO_SENDER_NAME  || 'Lobo24';
const STORE_WHATSAPP   = '543624235455'; // número con código de país sin +

// ===================== FIREBASE (Admin SDK) =====================
// Usamos credenciales de cuenta de servicio (no la API key pública) porque
// las Firestore Security Rules exigen ser admin autenticado para escribir
// "pedidos" o leer "users". La API key web NO es secreta (está a la vista
// en el código de cualquier página), así que no hay forma de darle acceso
// elevado a través de ella sin reabrir el mismo agujero que se cerró al
// bloquear la base de datos. El Admin SDK, en cambio, usa una credencial
// real que solo vive en las variables de entorno del backend y pasa por
// encima de las reglas, como corresponde a un servidor de confianza.
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

let db = null;

if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
        const firebaseApp = initializeApp({ credential: cert(serviceAccount) });
        db = getFirestore(firebaseApp);
        console.log('✅ Firebase Admin SDK inicializado');
    } catch (err) {
        console.error('❌ FIREBASE_SERVICE_ACCOUNT_JSON inválido:', err.message);
    }
} else {
    console.error('❌ Falta FIREBASE_SERVICE_ACCOUNT_JSON. El servidor no va a poder leer/escribir Firestore.');
}

// ===================== SISTEMA-VENTAS (segunda conexión, otro proyecto) =====================
// sistema-ventas es el POS del local — un proyecto de Firebase COMPLETAMENTE
// distinto a este (lobo24-9e46b). Esta segunda app (con nombre propio,
// 'sistema-ventas', para no pisar la de arriba) solo se usa para verificar
// que quien pide subir stock en /sincronizar-stock-pos es realmente un
// admin logueado en sistema-ventas en ese momento — nunca para nada más.
// Si falta la credencial, esa ruta específica queda deshabilitada, pero el
// resto del servidor (pagos, emails) sigue funcionando igual.
let sistemaVentasAuth = null;
let sistemaVentasDb = null;

if (process.env.SISTEMA_VENTAS_SERVICE_ACCOUNT_JSON) {
    try {
        const svServiceAccount = JSON.parse(process.env.SISTEMA_VENTAS_SERVICE_ACCOUNT_JSON);
        const svApp = initializeApp({ credential: cert(svServiceAccount) }, 'sistema-ventas');
        sistemaVentasAuth = getAuth(svApp);
        sistemaVentasDb = getFirestore(svApp);
        console.log('✅ Conexión a sistema-ventas inicializada (para verificar admins)');
    } catch (err) {
        console.error('❌ SISTEMA_VENTAS_SERVICE_ACCOUNT_JSON inválido:', err.message);
    }
} else {
    console.error('❌ Falta SISTEMA_VENTAS_SERVICE_ACCOUNT_JSON. /sincronizar-stock-pos no va a funcionar (el resto del servidor sigue igual).');
}

// Obtener doc
async function firestoreGet(collection, docId) {
    const snap = await db.collection(collection).doc(docId).get();
    return snap.exists ? snap.data() : null;
}

// Actualizar doc
async function firestorePatch(collection, docId, fields) {
    try {
        await db.collection(collection).doc(docId).update(fields);
        return true;
    } catch (err) {
        console.error(`❌ Error actualizando ${collection}/${docId}:`, err.message);
        return false;
    }
}

// Buscar pedido por orderId
async function buscarPedidoPorOrderId(orderId) {
    const snap = await db.collection('pedidos').where('orderId', '==', orderId).limit(1).get();
    if (snap.empty) return null;

    const doc = snap.docs[0];
    return { docId: doc.id, ...doc.data() };
}

// ===================== VALIDACIÓN DE PRECIOS (ANTI-TAMPERING) =====================
// El total que se le cobra al cliente en Mercado Pago NUNCA debe salir
// de un valor que mandó el navegador. Acá se recalcula desde los
// precios reales guardados en Firestore.
//
// El costo de envío sale de config/shipping en Firestore (mismo doc que
// lee js/checkout.js), para que exista un solo lugar donde cambiarlo en
// vez de dos constantes hardcodeadas que había que mantener sincronizadas
// a mano. Si el doc no existe todavía, se usan estos valores por defecto
// (los mismos que estaban hardcodeados antes).
const DEFAULT_SHIPPING = {
    LOCAL_MIN: 85000,
    COSTO_FIJO: 4500
};

let shippingConfigCache = { ...DEFAULT_SHIPPING };
let shippingConfigFetchedAt = 0;
const SHIPPING_CONFIG_TTL_MS = 5 * 60 * 1000;

async function getShippingConfig() {
    if (Date.now() - shippingConfigFetchedAt < SHIPPING_CONFIG_TTL_MS) {
        return shippingConfigCache;
    }
    try {
        const doc = await firestoreGet('config', 'shipping');
        if (doc) {
            shippingConfigCache = {
                LOCAL_MIN: Number(doc.localMin ?? DEFAULT_SHIPPING.LOCAL_MIN),
                COSTO_FIJO: Number(doc.costoFijo ?? DEFAULT_SHIPPING.COSTO_FIJO)
            };
        }
        shippingConfigFetchedAt = Date.now();
    } catch (err) {
        console.error('⚠️ No se pudo leer config/shipping, se usan los valores por defecto:', err.message);
    }
    return shippingConfigCache;
}

async function calcularTotalReal(items, delivery, pointsUsedSolicitado, userId) {
    let subtotal = 0;

    for (const item of items) {
        if (!item || !item.coleccion || !item.id) {
            throw new Error('Item sin coleccion/id válidos');
        }

        const qty = Number(item.quantity || 0);
        if (!Number.isFinite(qty) || qty <= 0) {
            throw new Error(`Cantidad inválida para ${item.id}`);
        }

        const producto = await firestoreGet(item.coleccion, item.id);
        if (!producto) {
            throw new Error(`Producto no encontrado: ${item.coleccion}/${item.id}`);
        }

        const precioReal = Number(producto.price || 0);

        if (!Number.isFinite(precioReal) || precioReal <= 0) {
            throw new Error(`Precio inválido para ${item.coleccion}/${item.id}`);
        }

        subtotal += precioReal * qty;
    }

    const SHIPPING = await getShippingConfig();
    const deliveryCost = delivery === 'local'
        ? 0
        : (subtotal >= SHIPPING.LOCAL_MIN ? 0 : SHIPPING.COSTO_FIJO);

    let pointsUsed = 0;
    const pointsSolicitados = Number(pointsUsedSolicitado || 0);

    if (pointsSolicitados > 0 && userId) {
        const usuario = await firestoreGet('users', userId);
        if (usuario) {
            const puntosDisponibles = Number(usuario.points || 0);
            const maxAplicable = Math.floor((subtotal + deliveryCost) * 0.30);
            pointsUsed = Math.max(0, Math.min(pointsSolicitados, puntosDisponibles, maxAplicable));
        }
    }

    const total = Math.max(0, subtotal + deliveryCost - pointsUsed);

    return { subtotal, deliveryCost, pointsUsed, total };
}

// ===================== DESCUENTO DE STOCK (pedidos pagados con Mercado Pago) =====================
// checkout.js ya descuenta el stock en el momento para transferencia/
// efectivo (el cliente confirma en persona). Para Mercado Pago, el stock
// recién se descuenta acá, cuando el webhook confirma el pago — nunca
// antes, para no restar stock de pedidos que el cliente nunca terminó de pagar.
async function descontarStockPedido(pedido) {
    const items = pedido.items || [];

    for (const item of items) {
        if (!item?.coleccion || !item?.docId) continue;

        try {
            const productoRef = db.collection(item.coleccion).doc(item.docId);

            await db.runTransaction(async (tx) => {
                const snap = await tx.get(productoRef);
                if (!snap.exists) return;

                const stockActual = snap.data().stock;
                if (stockActual === undefined || stockActual === null) return; // producto sin control de stock

                const nuevoStock = Math.max(0, Number(stockActual) - Number(item.qty || 0));
                tx.update(productoRef, { stock: nuevoStock });
            });
        } catch (err) {
            console.error(`❌ Error descontando stock de ${item.coleccion}/${item.docId}:`, err.message);
        }
    }
}

// ===================== HELPERS DE EMAIL =====================

function money(n) {
    return `$${Number(n || 0).toLocaleString('es-AR')}`;
}

function paymentLabel(payment) {
    if (payment === 'mp')        return 'Mercado Pago';
    if (payment === 'transfer')  return 'Transferencia bancaria';
    if (payment === 'efectivo')  return 'Efectivo en local';
    return payment || 'No informado';
}

function deliveryLabel(delivery) {
    if (delivery === 'local')           return 'Retiro en sucursal';
    if (delivery === 'domicilio_cerca') return 'Envío a domicilio ≤ 10 cuadras';
    if (delivery === 'domicilio_lejos') return 'Envío a domicilio > 10 cuadras';
    if (delivery === 'domicilio_prov')  return 'Envío a otra provincia';
    return delivery || 'No informado';
}

/**
 * Devuelve el mensaje de estado del pago según el método.
 * Se muestra en el email al cliente.
 */
function getStatusMessage(payment) {
    if (payment === 'mp') {
        return {
            badge: '⏳ Pago pendiente de verificación',
            body: `
              <p>Tu pago a través de <strong>Mercado Pago</strong> está siendo procesado.</p>
              <p>Te notificaremos por <strong>correo electrónico</strong> o por
              <strong>WhatsApp</strong> en cuanto confirmemos la acreditación del pago.</p>
            `
        };
    }
    if (payment === 'transfer') {
        return {
            badge: '⏳ Transferencia pendiente de verificación',
            body: `
              <p>Recibimos tu pedido. Cuando realices la transferencia bancaria,
              <strong>envianos el comprobante por WhatsApp</strong> al
              <a href="https://wa.me/${STORE_WHATSAPP}" style="color:#f59e0b">+54 362 423-5455</a>
              indicando tu número de pedido.</p>
              <p>Verificaremos el pago y te confirmaremos por <strong>correo electrónico</strong>
              o <strong>WhatsApp</strong> a la brevedad.</p>
            `
        };
    }
    if (payment === 'efectivo') {
        return {
            badge: '✅ Pedido confirmado — Pago en local',
            body: `
              <p>Tu pedido está <strong>confirmado</strong>. Podés pasar a retirarlo y abonar
              en efectivo en nuestro local.</p>
              <p>Ante cualquier duda, contactanos por <strong>WhatsApp</strong> al
              <a href="https://wa.me/${STORE_WHATSAPP}" style="color:#f59e0b">+54 362 423-5455</a>
              o respondé este correo.</p>
            `
        };
    }
    return { badge: '📋 Pedido recibido', body: '<p>Tu pedido fue registrado correctamente.</p>' };
}

// ===================== TEMPLATE HTML EMAIL =====================

function buildPedidoEmailHtml(pedido, tipo = 'cliente') {
    const items   = pedido.items   || [];
    const contact = pedido.contact || {};

    const productosHtml = items.map(item => `
        <tr>
          <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;font-size:14px">${item.name || ''}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;text-align:center;font-size:14px">${item.qty || 1}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;text-align:right;font-size:14px">${money(item.price)}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;text-align:right;font-size:14px;font-weight:600">${money(item.subtotal || Number(item.price || 0) * Number(item.qty || 1))}</td>
        </tr>
    `).join('');

    const statusMsg   = getStatusMessage(pedido.payment);
    const whatsLink   = `https://wa.me/${STORE_WHATSAPP}?text=${encodeURIComponent(`Hola Lobo24! Mi pedido es #${pedido.orderId || ''}. Quiero hacer una consulta.`)}`;
    const orderNum    = pedido.orderId || pedido.orderNumber || pedido.docId || '';

    // ── Bloque específico para el cliente ──
    const clienteStatusBlock = `
      <div style="background:#fffbeb;border-left:4px solid #f59e0b;border-radius:0 8px 8px 0;padding:16px 20px;margin:20px 0;font-size:14px;color:#78350f">
        <div style="font-weight:700;font-size:15px;margin-bottom:8px">${statusMsg.badge}</div>
        ${statusMsg.body}
      </div>
    `;

    // ── Bloque específico para el vendedor ──
    const vendedorStatusBlock = `
      <div style="background:#fef3c7;border-left:4px solid #d97706;border-radius:0 8px 8px 0;padding:14px 18px;margin:20px 0;font-size:14px;color:#92400e">
        <strong>Método de pago:</strong> ${paymentLabel(pedido.payment)}<br>
        <strong>Estado:</strong> ${pedido.status || '—'}<br>
        ${pedido.payment === 'transfer'
          ? '<strong>Acción requerida:</strong> Aguardá el comprobante del cliente por WhatsApp.'
          : pedido.payment === 'mp'
          ? '<strong>Acción requerida:</strong> El pago será confirmado automáticamente vía webhook.'
          : '<strong>Acción requerida:</strong> El cliente pagará en efectivo al retirar.'}
      </div>
    `;

    return `
      <!DOCTYPE html>
      <html lang="es">
      <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
      <body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif">
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 0">
          <tr><td align="center">
            <table width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e5e7eb">

              <!-- HEADER -->
              <tr>
                <td style="background:#111827;padding:28px 32px">
                  <div style="color:#f59e0b;font-size:28px;font-weight:900;letter-spacing:2px">LOBO<span style="color:#fff">24</span></div>
                  <div style="color:#9ca3af;font-size:13px;margin-top:4px">
                    ${tipo === 'vendedor' ? '🔔 Nuevo pedido recibido' : '🛍️ Confirmación de tu pedido'}
                  </div>
                </td>
              </tr>

              <!-- BODY -->
              <tr>
                <td style="padding:28px 32px">

                  <h2 style="margin:0 0 4px;font-size:20px;color:#111827">
                    Pedido <span style="color:#f59e0b">#${orderNum}</span>
                  </h2>
                  <p style="margin:0 0 24px;color:#6b7280;font-size:13px">
                    ${new Date().toLocaleDateString('es-AR', { year:'numeric', month:'long', day:'numeric' })}
                  </p>

                  <!-- STATUS BLOCK -->
                  ${tipo === 'cliente' ? clienteStatusBlock : vendedorStatusBlock}

                  <!-- DATOS DEL CLIENTE -->
                  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border-radius:10px;border:1px solid #e5e7eb;margin-bottom:24px">
                    <tr>
                      <td style="padding:16px 20px">
                        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#9ca3af;margin-bottom:12px">Datos del cliente</div>
                        <table cellpadding="0" cellspacing="0">
                          <tr><td style="font-size:13px;color:#6b7280;padding-bottom:6px;min-width:90px">👤 Nombre</td><td style="font-size:13px;color:#111827;font-weight:600;padding-bottom:6px">${contact.name || '—'}</td></tr>
                          <tr><td style="font-size:13px;color:#6b7280;padding-bottom:6px">📧 Email</td><td style="font-size:13px;color:#111827;padding-bottom:6px">${contact.email || '—'}</td></tr>
                          <tr><td style="font-size:13px;color:#6b7280;padding-bottom:6px">📱 Teléfono</td><td style="font-size:13px;color:#111827;padding-bottom:6px">${contact.phone || '—'}</td></tr>
                          <tr><td style="font-size:13px;color:#6b7280;padding-bottom:6px">📍 Dirección</td><td style="font-size:13px;color:#111827;padding-bottom:6px">${[contact.street, contact.city, contact.province].filter(Boolean).join(', ') || '—'}</td></tr>
                          ${contact.notes ? `<tr><td style="font-size:13px;color:#6b7280">💬 Notas</td><td style="font-size:13px;color:#111827">${contact.notes}</td></tr>` : ''}
                        </table>
                      </td>
                    </tr>
                  </table>

                  <!-- ENTREGA -->
                  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border-radius:10px;border:1px solid #e5e7eb;margin-bottom:24px">
                    <tr>
                      <td style="padding:16px 20px">
                        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#9ca3af;margin-bottom:10px">Entrega</div>
                        <div style="font-size:14px;color:#111827">🚚 ${deliveryLabel(pedido.delivery)}</div>
                      </td>
                    </tr>
                  </table>

                  <!-- PRODUCTOS -->
                  <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#9ca3af;margin-bottom:12px">Productos</div>
                  <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;margin-bottom:20px">
                    <thead>
                      <tr style="background:#f3f4f6">
                        <th style="padding:10px 12px;text-align:left;font-size:12px;color:#6b7280;font-weight:600">Producto</th>
                        <th style="padding:10px 12px;text-align:center;font-size:12px;color:#6b7280;font-weight:600">Cant.</th>
                        <th style="padding:10px 12px;text-align:right;font-size:12px;color:#6b7280;font-weight:600">Precio</th>
                        <th style="padding:10px 12px;text-align:right;font-size:12px;color:#6b7280;font-weight:600">Subtotal</th>
                      </tr>
                    </thead>
                    <tbody>${productosHtml}</tbody>
                  </table>

                  <!-- TOTALES -->
                  <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px">
                    <tr>
                      <td style="font-size:14px;color:#6b7280;padding-bottom:6px">Subtotal</td>
                      <td style="font-size:14px;color:#111827;text-align:right;padding-bottom:6px">${money(pedido.subtotal)}</td>
                    </tr>
                    <tr>
                      <td style="font-size:14px;color:#6b7280;padding-bottom:6px">Envío</td>
                      <td style="font-size:14px;color:#111827;text-align:right;padding-bottom:6px">
                        ${Number(pedido.deliveryCost || 0) === 0 ? '<span style="color:#16a34a">Gratis</span>' : money(pedido.deliveryCost)}
                      </td>
                    </tr>
                    ${Number(pedido.pointsUsed || 0) > 0 ? `
                    <tr>
                      <td style="font-size:14px;color:#6b7280;padding-bottom:6px">⭐ Descuento puntos</td>
                      <td style="font-size:14px;color:#7c3aed;text-align:right;padding-bottom:6px">-${money(pedido.pointsUsed)}</td>
                    </tr>` : ''}
                    <tr style="border-top:2px solid #e5e7eb">
                      <td style="font-size:18px;font-weight:800;color:#111827;padding-top:12px">Total</td>
                      <td style="font-size:18px;font-weight:800;color:#f59e0b;text-align:right;padding-top:12px">${money(pedido.total)}</td>
                    </tr>
                  </table>

                  ${tipo === 'cliente' ? `
                  <!-- CTA WHATSAPP (solo para cliente) -->
                  <table width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td align="center" style="padding-bottom:8px">
                        <a href="${whatsLink}" style="display:inline-block;background:#25d366;color:#fff;font-weight:700;font-size:14px;text-decoration:none;padding:14px 32px;border-radius:50px">
                          💬 Contactarnos por WhatsApp
                        </a>
                      </td>
                    </tr>
                    <tr>
                      <td align="center" style="font-size:12px;color:#9ca3af">También podés respondernos a este correo</td>
                    </tr>
                  </table>
                  ` : ''}

                </td>
              </tr>

              <!-- FOOTER -->
              <tr>
                <td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:20px 32px;text-align:center">
                  <div style="font-size:12px;color:#9ca3af">
                    Lobo24 · Sarmiento 322, Resistencia, Chaco<br>
                    <a href="https://wa.me/${STORE_WHATSAPP}" style="color:#f59e0b;text-decoration:none">+54 362 423-5455</a>
                    &nbsp;·&nbsp;
                    <a href="mailto:marketlobo24@gmail.com" style="color:#f59e0b;text-decoration:none">marketlobo24@gmail.com</a>
                  </div>
                </td>
              </tr>

            </table>
          </td></tr>
        </table>
      </body>
      </html>
    `;
}

// ===================== ENVIAR EMAILS CON BREVO =====================

async function enviarEmailsPedido(pedido) {
    if (!process.env.BREVO_API_KEY) {
        console.warn('⚠️ Falta BREVO_API_KEY. No se enviaron emails.');
        return;
    }

    const clienteEmail = pedido.contact?.email;
    const orderNum     = pedido.orderId || pedido.orderNumber || '';
    const sender       = { name: FROM_NAME, email: FROM_EMAIL };

    const emails = [];

    // Email al cliente
    if (clienteEmail) {
        emails.push({
            sender,
            to: [{ email: clienteEmail, name: pedido.contact?.name || '' }],
            subject: `Lobo24 — Tu pedido #${orderNum} fue recibido 🐺`,
            htmlContent: buildPedidoEmailHtml(pedido, 'cliente')
        });
    }

    // Email al vendedor
    emails.push({
        sender,
        to: [{ email: SELLER_EMAIL, name: 'Lobo24 Admin' }],
        subject: `🔔 Nuevo pedido #${orderNum} — ${paymentLabel(pedido.payment)}`,
        htmlContent: buildPedidoEmailHtml(pedido, 'vendedor')
    });

    for (const emailData of emails) {
        try {
            await brevoApi.sendTransacEmail(emailData);
            console.log('📩 Email enviado a:', emailData.to[0].email);
        } catch (error) {
            console.error('❌ Error enviando email con Brevo:', error?.response?.body || error.message || error);
        }
    }
}

// ===================== RUTAS =====================

app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'Servidor Lobo24 funcionando!' });
});

// ===================== CREAR PREFERENCIA =====================

app.post('/crear-preferencia', async (req, res) => {
    try {
        const { items, customerData, orderData } = req.body;

        if (!items || items.length === 0) {
            return res.status(400).json({ error: 'No hay productos' });
        }

        console.log('📦 BODY RECIBIDO:', JSON.stringify(req.body, null, 2));

        let totalFinal, subtotal, deliveryCost, pointsUsed;

        try {
            ({ total: totalFinal, subtotal, deliveryCost, pointsUsed } = await calcularTotalReal(
                items,
                orderData?.delivery,
                orderData?.pointsUsed,
                orderData?.userId
            ));
        } catch (validationError) {
            console.error('❌ No se pudo validar el pedido contra Firestore:', validationError.message);
            return res.status(400).json({ error: 'No se pudo validar el pedido: ' + validationError.message });
        }

        if (!totalFinal || totalFinal <= 0) {
            console.error('❌ Total calculado inválido:', { totalFinal, orderData });
            return res.status(400).json({ error: 'Total inválido para Mercado Pago' });
        }

        const externalReference =
            orderData.orderId ||
            orderData.orderNumber ||
            `LOBO-${Date.now()}`;

        // El pedido ya existe en Firestore (lo crea checkout.js antes de
        // llamar acá). Lo actualizamos con los valores validados para que
        // el registro coincida con lo que realmente se le va a cobrar.
        try {
            const pedidoExistente = await buscarPedidoPorOrderId(externalReference);
            if (pedidoExistente) {
                await firestorePatch('pedidos', pedidoExistente.docId, {
                    subtotal,
                    deliveryCost,
                    pointsUsed,
                    total: totalFinal
                });
            }
        } catch (patchError) {
            console.warn('⚠️ No se pudo sincronizar el pedido con el total validado:', patchError.message);
        }

        const mpItems = [
            {
                id: externalReference,
                title: `Pedido Lobo24 ${externalReference}`,
                quantity: 1,
                unit_price: totalFinal,
                currency_id: 'ARS'
            }
        ];

        const preference = new Preference(mpClient);

        const result = await preference.create({
            body: {
                items: mpItems,
                payer: {
                    name: customerData.name,
                    email: customerData.email,
                    phone: { number: customerData.phone }
                },

                external_reference: externalReference,
                statement_descriptor: 'LOBO24',

                back_urls: {
                    success: `${process.env.FRONTEND_URL}/checkout.html?mp_status=success&order=${externalReference}`,
                    failure: `${process.env.FRONTEND_URL}/checkout.html?mp_status=failure&order=${externalReference}`,
                    pending: `${process.env.FRONTEND_URL}/checkout.html?mp_status=pending&order=${externalReference}`
                },

                auto_return: 'approved',

                notification_url: `${process.env.BACKEND_URL}/webhook`
            }
        });

        console.log('✅ Preferencia creada:', result.id, '| Orden:', externalReference);

        res.json({
            id: result.id,
            init_point: result.init_point,
            sandbox_init_point: result.sandbox_init_point
        });

    } catch (error) {
        console.error('❌ Error MP:', error);
        res.status(500).json({ error: 'Error al crear pago' });
    }
});

// ===================== SINCRONIZAR STOCK (subidas desde sistema-ventas) =====================
// Las bajas de stock por venta ya se manejan directo con las reglas de
// Firestore de Lobo24 (mismo mecanismo que usa cualquier compra online: un
// cliente sin login puede bajar stock, nunca subirlo). Esta ruta es SOLO
// para subidas (entrada de mercadería en el local) — dejar eso abierto a
// cualquiera permitiría inflar el stock de un producto sin haber comprado
// nada, por eso acá sí se verifica de verdad que quien llama es un admin
// logueado en sistema-ventas en este momento (no alcanza con tener una
// clave copiada de algún lado).
const COLECCIONES_VALIDAS_LOBO24 = [
    'bebidas', 'snacks', 'almacen', 'higiene', 'limpieza',
    'congelados', 'lacteos', 'panaderia', 'mascotas', 'ofertas'
];

// Acepta stock y/o price — el nombre de la ruta quedó del alcance
// original (solo stock), pero ahora también sincroniza precio: ninguno de
// los dos se puede tocar sin login en las reglas de Lobo24, así que los
// dos necesitan pasar por acá, verificados igual.
app.post('/sincronizar-stock-pos', async (req, res) => {
    try {
        if (!sistemaVentasAuth || !sistemaVentasDb || !db) {
            return res.status(503).json({ error: 'Sincronización no disponible en el servidor' });
        }

        const { idToken, coleccion, docId, stock, price, priceEfectivo } = req.body || {};

        if (!idToken || typeof idToken !== 'string') {
            return res.status(400).json({ error: 'Falta idToken' });
        }
        if (!COLECCIONES_VALIDAS_LOBO24.includes(coleccion)) {
            return res.status(400).json({ error: 'Colección inválida' });
        }
        if (!docId || typeof docId !== 'string') {
            return res.status(400).json({ error: 'Falta docId' });
        }

        const fields = {};
        if (stock !== undefined) {
            const stockNum = Number(stock);
            if (!Number.isFinite(stockNum) || stockNum < 0) {
                return res.status(400).json({ error: 'Stock inválido' });
            }
            fields.stock = Math.round(stockNum);
        }
        if (price !== undefined) {
            const priceNum = Number(price);
            if (!Number.isFinite(priceNum) || priceNum < 0) {
                return res.status(400).json({ error: 'Precio inválido' });
            }
            fields.price = Math.round(priceNum * 100) / 100;
        }
        if (priceEfectivo !== undefined) {
            const priceEfectivoNum = Number(priceEfectivo);
            if (!Number.isFinite(priceEfectivoNum) || priceEfectivoNum < 0) {
                return res.status(400).json({ error: 'Precio efectivo inválido' });
            }
            fields.priceEfectivo = Math.round(priceEfectivoNum * 100) / 100;
        }
        if (Object.keys(fields).length === 0) {
            return res.status(400).json({ error: 'Nada para sincronizar (falta stock, price o priceEfectivo)' });
        }

        let decoded;
        try {
            decoded = await sistemaVentasAuth.verifyIdToken(idToken);
        } catch (err) {
            return res.status(401).json({ error: 'Token inválido o vencido' });
        }

        const perfilSnap = await sistemaVentasDb.collection('usuarios').doc(decoded.uid).get();
        const perfil = perfilSnap.exists ? perfilSnap.data() : null;

        if (!perfil || perfil.rol !== 'admin' || perfil.activo === false) {
            return res.status(403).json({ error: 'Solo un admin de sistema-ventas puede sincronizar' });
        }

        const ok = await firestorePatch(coleccion, docId, fields);
        if (!ok) return res.status(500).json({ error: 'No se pudo actualizar el producto en Lobo24' });

        res.json({ ok: true });
    } catch (err) {
        console.error('❌ Error en /sincronizar-stock-pos:', err);
        res.status(500).json({ error: 'Error interno' });
    }
});

// ===================== ENDPOINT: EMAIL PARA PEDIDOS NO-MP =====================
// checkout.js lo llama luego de guardar en Firestore (transfer / efectivo)

app.post('/enviar-email-pedido', async (req, res) => {
    try {
        const pedido = req.body;

        if (!pedido || !pedido.orderId) {
            return res.status(400).json({ error: 'Datos de pedido inválidos' });
        }

        await enviarEmailsPedido(pedido);

        res.json({ ok: true });
    } catch (err) {
        console.error('❌ Error en /enviar-email-pedido:', err);
        res.status(500).json({ error: 'Error al enviar email' });
    }
});

// ===================== WEBHOOK (Mercado Pago) =====================

app.post('/webhook', async (req, res) => {
    res.sendStatus(200);

    try {
        const { type, data } = req.body;

        if (type !== 'payment' || !data?.id) return;

        const payment = new Payment(mpClient);
        const payInfo = await payment.get({ id: data.id });

        const status  = payInfo.status;
        const orderId = payInfo.external_reference;

        console.log('💳 Pago:', status, '| Orden:', orderId);

        const pedido = await buscarPedidoPorOrderId(orderId);

        if (!pedido) return;

        if (status === 'approved') {

            // Mercado Pago puede reenviar la misma notificación más de una
            // vez. Si el pedido ya estaba confirmado, no volvemos a
            // descontar stock ni a reenviar el email.
            const yaEstabaConfirmado = pedido.status === 'payment_confirmed';

            await firestorePatch('pedidos', pedido.docId, {
                status: 'payment_confirmed',
                mpPaymentId: String(data.id)
            });

            if (yaEstabaConfirmado) {
                console.log('ℹ️ Pedido ya estaba confirmado, se ignora la notificación repetida');
            } else {
                await descontarStockPedido(pedido);
                console.log('✅ Pedido aprobado, stock descontado');
                await enviarEmailsPedido({
                    ...pedido,
                    status: 'payment_confirmed',
                    mpPaymentId: String(data.id)
                });
            }

        } else if (status === 'rejected') {

            await firestorePatch('pedidos', pedido.docId, {
                status: 'cancelled'
            });

        } else if (status === 'pending') {

            await firestorePatch('pedidos', pedido.docId, {
                status: 'pending_payment'
            });
        }

    } catch (err) {
        console.error('❌ Error webhook:', err);
    }
});

// ===================== START =====================

app.listen(PORT, () => {
    console.log(`🚀 Servidor en http://localhost:${PORT}`);
});