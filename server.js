cat > /mnt/user-data/outputs/server.js << 'EOF'
const express = require('express');
const cors    = require('cors');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3000;

// ===================== CONFIGURACIÓN =====================

app.use(cors({
  origin: [
    'http://127.0.0.1:5500',
    'http://localhost:5500',
    'https://lobo24-9e46b.web.app',
    'https://lobo24-9e46b.firebaseapp.com'
  ],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));

app.use(express.json());

// ===================== MERCADO PAGO =====================

const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');

const mpClient = new MercadoPagoConfig({
    accessToken: process.env.MP_ACCESS_TOKEN
});

// ===================== RESEND (EMAILS) =====================

const { Resend } = require('resend');
const resend      = new Resend(process.env.RESEND_API_KEY);
const FROM_EMAIL  = process.env.FROM_EMAIL   || 'Lobo24 <onboarding@resend.dev>';
const SELLER_EMAIL= process.env.SELLER_EMAIL || 'marketlobo24@gmail.com';

// ===================== FIREBASE =====================

const FIREBASE_PROJECT = process.env.FIREBASE_PROJECT;
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;

async function firestoreGet(collection, docId) {
    const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${collection}/${docId}?key=${FIREBASE_API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
}

async function firestorePatch(collection, docId, fields) {
    const fieldPaths = Object.keys(fields).map(k => `updateMask.fieldPaths=${k}`).join('&');
    const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${collection}/${docId}?${fieldPaths}&key=${FIREBASE_API_KEY}`;

    const firestoreFields = {};
    for (const [k, v] of Object.entries(fields)) {
        if (typeof v === 'string')       firestoreFields[k] = { stringValue: v };
        else if (typeof v === 'number')  firestoreFields[k] = { integerValue: String(Math.floor(v)) };
        else if (typeof v === 'boolean') firestoreFields[k] = { booleanValue: v };
    }

    const res = await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: firestoreFields })
    });
    return res.ok;
}

async function buscarPedidoPorOrderId(orderId) {
    const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents:runQuery?key=${FIREBASE_API_KEY}`;
    const body = {
        structuredQuery: {
            from: [{ collectionId: 'pedidos' }],
            where: {
                fieldFilter: {
                    field: { fieldPath: 'orderId' },
                    op: 'EQUAL',
                    value: { stringValue: orderId }
                }
            },
            limit: 1
        }
    };

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    if (!res.ok) return null;

    const data = await res.json();
    if (!data || !data[0] || !data[0].document) return null;

    const doc   = data[0].document;
    const docId = doc.name.split('/').pop();

    // Extraer todos los campos incluyendo arrays anidados
    return { docId, ...extraerCampos(doc.fields) };
}

// Convierte campos Firestore → JS, incluyendo arrays y mapas anidados
function extraerCampos(fields) {
    if (!fields) return {};
    const result = {};

    for (const [k, v] of Object.entries(fields)) {
        if      (v.stringValue  !== undefined) result[k] = v.stringValue;
        else if (v.integerValue !== undefined) result[k] = Number(v.integerValue);
        else if (v.doubleValue  !== undefined) result[k] = Number(v.doubleValue);
        else if (v.booleanValue !== undefined) result[k] = v.booleanValue;
        else if (v.nullValue    !== undefined) result[k] = null;
        else if (v.arrayValue) {
            // ← CORRECCIÓN: desanidar arrays (items del pedido)
            result[k] = (v.arrayValue.values || []).map(item => {
                if (item.mapValue) return extraerCampos(item.mapValue.fields);
                if (item.stringValue  !== undefined) return item.stringValue;
                if (item.integerValue !== undefined) return Number(item.integerValue);
                if (item.doubleValue  !== undefined) return Number(item.doubleValue);
                if (item.booleanValue !== undefined) return item.booleanValue;
                return null;
            });
        }
        else if (v.mapValue) {
            result[k] = extraerCampos(v.mapValue.fields);
        }
    }
    return result;
}

// ===================== HELPERS EMAIL =====================

function money(n) {
    return `$${Number(n || 0).toLocaleString('es-AR')}`;
}

function paymentLabel(p) {
    const map = { mp: 'Mercado Pago', transfer: 'Transferencia bancaria', efectivo: 'Efectivo en local' };
    return map[p] || p || '—';
}

function deliveryLabel(d) {
    const map = {
        local:           'Retiro en sucursal',
        domicilio_cerca: 'Envío a domicilio ≤ 10 cuadras',
        domicilio_lejos: 'Envío a domicilio > 10 cuadras',
        domicilio_prov:  'Envío a otra provincia'
    };
    return map[d] || d || '—';
}

function buildEmailHtml(pedido, tipo = 'cliente') {
    const items   = pedido.items   || [];
    const contact = pedido.contact || {};
    const orderNum = pedido.orderId || pedido.orderNumber || pedido.docId || '';

    const productosHtml = items.length > 0
        ? items.map(item => `
            <tr>
              <td style="padding:10px 8px;border-bottom:1px solid #f0f0f0">${item.name || '—'}</td>
              <td style="padding:10px 8px;border-bottom:1px solid #f0f0f0;text-align:center">${item.qty || 1}</td>
              <td style="padding:10px 8px;border-bottom:1px solid #f0f0f0;text-align:right">${money(item.price)}</td>
              <td style="padding:10px 8px;border-bottom:1px solid #f0f0f0;text-align:right;font-weight:600">${money(item.subtotal || Number(item.price || 0) * Number(item.qty || 1))}</td>
            </tr>`).join('')
        : `<tr><td colspan="4" style="padding:12px;text-align:center;color:#999">Sin detalle de productos</td></tr>`;

    const titulo = tipo === 'vendedor'
        ? `🛒 Nuevo pedido recibido #${orderNum}`
        : `✅ Confirmación de tu compra #${orderNum}`;

    const intro = tipo === 'vendedor'
        ? `Un cliente realizó una nueva compra en Lobo24.`
        : `¡Hola ${contact.name?.split(' ')[0] || ''}! Tu pedido fue registrado correctamente.`;

    return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,Helvetica,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:24px 0">
    <tr><td align="center">
      <table width="100%" style="max-width:620px;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e8e8e8">

        <!-- HEADER -->
        <tr>
          <td style="background:#111827;padding:24px 28px">
            <h1 style="margin:0;color:#fff;font-size:28px;letter-spacing:1px">LOBO<span style="color:#f0c040">24</span></h1>
            <p style="margin:6px 0 0;color:#aaa;font-size:14px">${intro}</p>
          </td>
        </tr>

        <!-- NÚMERO DE PEDIDO -->
        <tr>
          <td style="padding:20px 28px 0">
            <div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;padding:12px 16px;display:inline-block">
              <span style="font-size:13px;color:#92400e;font-weight:600">📋 Pedido #${orderNum}</span>
            </div>
          </td>
        </tr>

        <!-- DATOS DEL CLIENTE -->
        <tr>
          <td style="padding:20px 28px 0">
            <h3 style="margin:0 0 12px;font-size:15px;color:#374151;border-bottom:2px solid #f3f4f6;padding-bottom:8px">👤 Datos del cliente</h3>
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="padding:4px 0;width:120px;color:#6b7280;font-size:14px">Nombre</td>
                <td style="padding:4px 0;font-size:14px;font-weight:600">${contact.name || '—'}</td>
              </tr>
              <tr>
                <td style="padding:4px 0;color:#6b7280;font-size:14px">Email</td>
                <td style="padding:4px 0;font-size:14px">${contact.email || '—'}</td>
              </tr>
              <tr>
                <td style="padding:4px 0;color:#6b7280;font-size:14px">Teléfono</td>
                <td style="padding:4px 0;font-size:14px">${contact.phone || '—'}</td>
              </tr>
              <tr>
                <td style="padding:4px 0;color:#6b7280;font-size:14px">Dirección</td>
                <td style="padding:4px 0;font-size:14px">${[contact.street, contact.city, contact.province].filter(Boolean).join(', ') || '—'}</td>
              </tr>
              ${contact.notes ? `<tr><td style="padding:4px 0;color:#6b7280;font-size:14px">Notas</td><td style="padding:4px 0;font-size:14px">${contact.notes}</td></tr>` : ''}
            </table>
          </td>
        </tr>

        <!-- ENTREGA Y PAGO -->
        <tr>
          <td style="padding:16px 28px 0">
            <h3 style="margin:0 0 12px;font-size:15px;color:#374151;border-bottom:2px solid #f3f4f6;padding-bottom:8px">🚚 Entrega y pago</h3>
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="padding:4px 0;width:120px;color:#6b7280;font-size:14px">Entrega</td>
                <td style="padding:4px 0;font-size:14px;font-weight:600">${deliveryLabel(pedido.delivery)}</td>
              </tr>
              <tr>
                <td style="padding:4px 0;color:#6b7280;font-size:14px">Pago</td>
                <td style="padding:4px 0;font-size:14px;font-weight:600">${paymentLabel(pedido.payment)}</td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- PRODUCTOS -->
        <tr>
          <td style="padding:16px 28px 0">
            <h3 style="margin:0 0 12px;font-size:15px;color:#374151;border-bottom:2px solid #f3f4f6;padding-bottom:8px">🛍️ Productos</h3>
            <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #f0f0f0;border-radius:8px;overflow:hidden">
              <thead>
                <tr style="background:#f9fafb">
                  <th style="padding:10px 8px;text-align:left;font-size:13px;color:#6b7280;font-weight:600">Producto</th>
                  <th style="padding:10px 8px;text-align:center;font-size:13px;color:#6b7280;font-weight:600">Cant.</th>
                  <th style="padding:10px 8px;text-align:right;font-size:13px;color:#6b7280;font-weight:600">Precio</th>
                  <th style="padding:10px 8px;text-align:right;font-size:13px;color:#6b7280;font-weight:600">Subtotal</th>
                </tr>
              </thead>
              <tbody>${productosHtml}</tbody>
            </table>
          </td>
        </tr>

        <!-- TOTALES -->
        <tr>
          <td style="padding:16px 28px">
            <table width="100%" cellpadding="0" cellspacing="0" style="border-top:2px solid #f3f4f6;padding-top:12px">
              <tr>
                <td style="padding:4px 0;color:#6b7280;font-size:14px">Subtotal</td>
                <td style="padding:4px 0;text-align:right;font-size:14px">${money(pedido.subtotal)}</td>
              </tr>
              <tr>
                <td style="padding:4px 0;color:#6b7280;font-size:14px">Envío</td>
                <td style="padding:4px 0;text-align:right;font-size:14px">${Number(pedido.deliveryCost || 0) === 0 ? '<span style="color:#16a34a">Gratis</span>' : money(pedido.deliveryCost)}</td>
              </tr>
              ${Number(pedido.pointsUsed || 0) > 0 ? `
              <tr>
                <td style="padding:4px 0;color:#6b7280;font-size:14px">⭐ Descuento puntos</td>
                <td style="padding:4px 0;text-align:right;font-size:14px;color:#16a34a">-${money(pedido.pointsUsed)}</td>
              </tr>` : ''}
              <tr>
                <td style="padding:10px 0 0;font-size:17px;font-weight:700">TOTAL</td>
                <td style="padding:10px 0 0;text-align:right;font-size:20px;font-weight:700;color:#f0c040">${money(pedido.total)}</td>
              </tr>
            </table>
          </td>
        </tr>

        ${pedido.payment === 'transfer' ? `
        <!-- DATOS DE TRANSFERENCIA -->
        <tr>
          <td style="padding:0 28px 20px">
            <div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;padding:14px 16px">
              <p style="margin:0 0 6px;font-weight:700;font-size:14px">📌 Completá tu pago por transferencia:</p>
              <p style="margin:4px 0;font-size:13px;color:#555">Alias: <strong>LOBO24.PAGO</strong></p>
              <p style="margin:4px 0;font-size:13px;color:#555">CBU: <strong>0110599920000012345678</strong></p>
              <p style="margin:4px 0;font-size:13px;color:#555">Monto exacto: <strong>${money(pedido.total)}</strong></p>
              <p style="margin:8px 0 0;font-size:12px;color:#92400e">Enviá el comprobante por WhatsApp con el número de pedido #${orderNum}.</p>
            </div>
          </td>
        </tr>` : ''}

        <!-- FOOTER -->
        <tr>
          <td style="background:#111827;padding:16px 28px;text-align:center">
            <p style="margin:0;color:#9ca3af;font-size:12px">LOBO24 — Sarmiento 322, Resistencia, Chaco · Abierto 24hs</p>
            <p style="margin:6px 0 0;color:#6b7280;font-size:11px">© 2025 Lobo24. Todos los derechos reservados.</p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

async function enviarEmailsPedido(pedido) {
    if (!process.env.RESEND_API_KEY) {
        console.warn('⚠️  Falta RESEND_API_KEY — emails no enviados');
        return;
    }

    const orderNum    = pedido.orderId || pedido.orderNumber || pedido.docId || '';
    const clientEmail = pedido.contact?.email;

    const emailsAEnviar = [];

    // Email al comprador
    if (clientEmail) {
        emailsAEnviar.push({
            from:    FROM_EMAIL,
            to:      [clientEmail],
            subject: `✅ Compra confirmada en Lobo24 — Pedido #${orderNum}`,
            html:    buildEmailHtml(pedido, 'cliente')
        });
    }

    // Email al vendedor
    emailsAEnviar.push({
        from:    FROM_EMAIL,
        to:      [SELLER_EMAIL],
        subject: `🛒 Nuevo pedido en Lobo24 — #${orderNum} — ${money(pedido.total)}`,
        html:    buildEmailHtml(pedido, 'vendedor')
    });

    for (const email of emailsAEnviar) {
        try {
            const { data, error } = await resend.emails.send(email);
            if (error) console.error('❌ Email error a', email.to, ':', error);
            else       console.log('📩 Email enviado a', email.to[0], '| id:', data?.id);
        } catch(e) {
            console.error('❌ Excepción enviando email:', e?.message || e);
        }
    }
}

// ===================== RUTAS =====================

app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'Servidor Lobo24 funcionando!' });
});

// ──────────────────────────────────────────────
// CREAR PREFERENCIA MP
// ──────────────────────────────────────────────
app.post('/crear-preferencia', async (req, res) => {
    try {
        const { items, customerData, orderData } = req.body;

        console.log('📦 /crear-preferencia recibido:', JSON.stringify({ items, orderData }, null, 2));

        if (!items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: 'No hay productos en el carrito' });
        }

        // Calcular total: usar el del frontend, o sumar items como fallback
        let totalFinal = Number(orderData?.total) || 0;

        if (totalFinal <= 0) {
            totalFinal = items.reduce((sum, i) => sum + Number(i.price || 0) * Number(i.quantity || 1), 0);
            console.log('⚠️  Total calculado desde items:', totalFinal);
        }

        totalFinal = Math.round(totalFinal * 100) / 100; // 2 decimales

        if (totalFinal <= 0) {
            return res.status(400).json({ error: 'No se pudo calcular el total del pedido' });
        }

        const externalReference =
            orderData?.orderId ||
            orderData?.orderNumber ||
            `LOBO-${Date.now()}`;

        const preference = new Preference(mpClient);

        const result = await preference.create({
            body: {
                items: [{
                    id:         externalReference,
                    title:      `Pedido Lobo24 #${externalReference}`,
                    quantity:   1,
                    unit_price: totalFinal,
                    currency_id:'ARS'
                }],
                payer: {
                    name:  customerData?.name  || '',
                    email: customerData?.email || '',
                    phone: { number: String(customerData?.phone || '') }
                },
                external_reference:   externalReference,
                statement_descriptor: 'LOBO24',
                back_urls: {
                    success: `${process.env.FRONTEND_URL}/checkout.html?mp_status=success&order=${externalReference}`,
                    failure: `${process.env.FRONTEND_URL}/checkout.html?mp_status=failure&order=${externalReference}`,
                    pending: `${process.env.FRONTEND_URL}/checkout.html?mp_status=pending&order=${externalReference}`
                },
                auto_return:      'approved',
                notification_url: `${process.env.BACKEND_URL}/webhook`
            }
        });

        console.log('✅ Preferencia creada:', result.id, '| Total:', totalFinal, '| Ref:', externalReference);

        res.json({
            id:                 result.id,
            init_point:         result.init_point,
            sandbox_init_point: result.sandbox_init_point
        });

    } catch (error) {
        console.error('❌ Error MP:', error?.message || error);
        res.status(500).json({ error: 'Error interno al crear el pago' });
    }
});

// ──────────────────────────────────────────────
// WEBHOOK MP
// ──────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
    res.sendStatus(200); // responder rápido a MP

    try {
        const { type, data } = req.body;
        console.log('📬 Webhook recibido — tipo:', type, '| id:', data?.id);

        if (type !== 'payment' || !data?.id) return;

        const paymentApi = new Payment(mpClient);
        const payInfo    = await paymentApi.get({ id: data.id });

        const status  = payInfo.status;
        const orderId = payInfo.external_reference;

        console.log(`💳 Pago ${data.id} — estado: ${status} | orden: ${orderId}`);

        if (!orderId) return;

        const pedido = await buscarPedidoPorOrderId(orderId);
        if (!pedido) {
            console.warn('⚠️  Pedido no encontrado para orderId:', orderId);
            return;
        }

        if (status === 'approved') {

            await firestorePatch('pedidos', pedido.docId, {
                status:      'payment_confirmed',
                mpPaymentId: String(data.id)
            });

            console.log('✅ Pedido confirmado:', orderId);

            // Enviar emails con los datos completos del pedido
            await enviarEmailsPedido({
                ...pedido,
                status:      'payment_confirmed',
                mpPaymentId: String(data.id)
            });

        } else if (status === 'rejected') {

            await firestorePatch('pedidos', pedido.docId, {
                status:      'cancelled',
                mpPaymentId: String(data.id)
            });
            console.log('❌ Pago rechazado:', orderId);

        } else if (status === 'pending' || status === 'in_process') {

            await firestorePatch('pedidos', pedido.docId, {
                status:      'pending_payment',
                mpPaymentId: String(data.id)
            });
            console.log('⏳ Pago pendiente:', orderId);
        }

    } catch (err) {
        console.error('❌ Error en webhook:', err?.message || err);
    }
});

// ──────────────────────────────────────────────
// EMAIL MANUAL (para transferencia/efectivo)
// Llamado desde checkout.js cuando se confirma transferencia
// ──────────────────────────────────────────────
app.post('/enviar-email-pedido', async (req, res) => {
    try {
        const { pedido } = req.body;
        if (!pedido) return res.status(400).json({ error: 'Falta el pedido' });

        await enviarEmailsPedido(pedido);
        res.json({ ok: true });
    } catch(e) {
        console.error('❌ Error enviando email manual:', e);
        res.status(500).json({ error: 'Error al enviar email' });
    }
});

// ===================== START =====================

app.listen(PORT, () => {
    console.log(`\n🚀 Servidor Lobo24 corriendo en http://localhost:${PORT}`);
    console.log(`📦 Modo MP: ${(process.env.MP_ACCESS_TOKEN || '').startsWith('APP_USR') ? '✅ PRODUCCIÓN' : '🧪 TEST'}`);
    console.log(`📩 Emails desde: ${FROM_EMAIL}`);
    console.log(`📩 Vendedor: ${SELLER_EMAIL}`);
    console.log(`🌐 Frontend: ${process.env.FRONTEND_URL}`);
    console.log(`🔔 Webhook: ${process.env.BACKEND_URL}/webhook\n`);
});
EOF
