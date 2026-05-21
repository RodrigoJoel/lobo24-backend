const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const ALLOWED_ORIGINS = [
  'http://127.0.0.1:5500',
  'http://localhost:5500',
  'https://lobo24-9e46b.web.app',
  'https://lobo24-9e46b.firebaseapp.com',
  'https://marketlobo24.com.ar',
  'https://www.marketlobo24.com.ar'
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Origen no permitido por CORS: ' + origin));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

app.options('*', cors());

app.use(express.json());

// ===================== MERCADO PAGO =====================

const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');

const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN
});

// ===================== BREVO =====================

const SibApiV3Sdk = require('sib-api-v3-sdk');
const brevoClient = SibApiV3Sdk.ApiClient.instance;
brevoClient.authentications['api-key'].apiKey = process.env.BREVO_API_KEY;

const brevoApi = new SibApiV3Sdk.TransactionalEmailsApi();

const SELLER_EMAIL = process.env.SELLER_EMAIL || 'marketlobo24@gmail.com';
const FROM_EMAIL = process.env.BREVO_SENDER_EMAIL || 'onboarding@resend.dev';
const FROM_NAME = process.env.BREVO_SENDER_NAME || 'Lobo24';
const STORE_WHATSAPP = '543624235455';

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://marketlobo24.com.ar';
const BACKEND_URL = process.env.BACKEND_URL || 'https://lobo24-backend.onrender.com';

// ===================== FIREBASE =====================

const FIREBASE_PROJECT = process.env.FIREBASE_PROJECT;
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;

async function firestorePatch(collection, docId, fields) {
  const fieldPaths = Object.keys(fields).map(k => `updateMask.fieldPaths=${k}`).join('&');

  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${collection}/${docId}?${fieldPaths}&key=${FIREBASE_API_KEY}`;

  const firestoreFields = {};

  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'string') firestoreFields[k] = { stringValue: v };
    else if (typeof v === 'number') firestoreFields[k] = { integerValue: String(Math.floor(v)) };
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

  const doc = data[0].document;
  const docId = doc.name.split('/').pop();

  return { docId, ...extraerCampos(doc.fields) };
}

function extraerCampos(fields) {
  if (!fields) return {};
  const result = {};

  for (const [k, v] of Object.entries(fields)) {
    if (v.stringValue !== undefined) result[k] = v.stringValue;
    else if (v.integerValue !== undefined) result[k] = Number(v.integerValue);
    else if (v.doubleValue !== undefined) result[k] = Number(v.doubleValue);
    else if (v.booleanValue !== undefined) result[k] = v.booleanValue;
  }

  return result;
}

// ===================== HELPERS =====================

function money(n) {
  return `$${Number(n || 0).toLocaleString('es-AR')}`;
}

function paymentLabel(payment) {
  if (payment === 'mp') return 'Mercado Pago';
  if (payment === 'transfer') return 'Transferencia bancaria';
  if (payment === 'efectivo') return 'Efectivo en local';
  return payment || 'No informado';
}

function deliveryLabel(delivery) {
  if (delivery === 'local') return 'Retiro en sucursal';
  if (delivery === 'domicilio') return 'Envío a domicilio hasta 18 km';
  return delivery || 'No informado';
}

function getStatusMessage(payment) {
  if (payment === 'mp') {
    return {
      badge: '⏳ Pago pendiente de verificación',
      body: `
        <p>Tu pago a través de <strong>Mercado Pago</strong> está siendo procesado.</p>
        <p>Te notificaremos por <strong>correo electrónico</strong> o por <strong>WhatsApp</strong> cuando se confirme.</p>
      `
    };
  }

  if (payment === 'transfer') {
    return {
      badge: '⏳ Transferencia pendiente de verificación',
      body: `
        <p>Recibimos tu pedido. Cuando realices la transferencia, envianos el comprobante por WhatsApp al
        <a href="https://wa.me/${STORE_WHATSAPP}" style="color:#f59e0b">+54 362 423-5455</a>.</p>
      `
    };
  }

  if (payment === 'efectivo') {
    return {
      badge: '✅ Pedido confirmado — Pago en local',
      body: `<p>Tu pedido está confirmado. Podés pasar a retirarlo y abonar en efectivo en nuestro local.</p>`
    };
  }

  return {
    badge: '📋 Pedido recibido',
    body: '<p>Tu pedido fue registrado correctamente.</p>'
  };
}

// ===================== EMAIL =====================

function buildPedidoEmailHtml(pedido, tipo = 'cliente') {
  const items = pedido.items || [];
  const contact = pedido.contact || {};

  const productosHtml = items.map(item => `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;font-size:14px">${item.name || ''}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;text-align:center;font-size:14px">${item.qty || 1}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;text-align:right;font-size:14px">${money(item.price)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;text-align:right;font-size:14px;font-weight:600">${money(item.subtotal || Number(item.price || 0) * Number(item.qty || 1))}</td>
    </tr>
  `).join('');

  const statusMsg = getStatusMessage(pedido.payment);
  const orderNum = pedido.orderId || pedido.orderNumber || pedido.docId || '';
  const whatsLink = `https://wa.me/${STORE_WHATSAPP}?text=${encodeURIComponent(`Hola Lobo24! Mi pedido es #${orderNum}. Quiero hacer una consulta.`)}`;

  return `
  <!DOCTYPE html>
  <html lang="es">
  <head><meta charset="UTF-8"></head>
  <body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 0">
      <tr><td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e5e7eb">
          <tr>
            <td style="background:#111827;padding:28px 32px">
              <div style="color:#f59e0b;font-size:28px;font-weight:900;letter-spacing:2px">LOBO<span style="color:#fff">24</span></div>
              <div style="color:#9ca3af;font-size:13px;margin-top:4px">
                ${tipo === 'vendedor' ? '🔔 Nuevo pedido recibido' : '🛍️ Confirmación de tu pedido'}
              </div>
            </td>
          </tr>

          <tr>
            <td style="padding:28px 32px">
              <h2 style="margin:0 0 4px;font-size:20px;color:#111827">
                Pedido <span style="color:#f59e0b">#${orderNum}</span>
              </h2>

              <div style="background:#fffbeb;border-left:4px solid #f59e0b;border-radius:0 8px 8px 0;padding:16px 20px;margin:20px 0;font-size:14px;color:#78350f">
                <div style="font-weight:700;font-size:15px;margin-bottom:8px">${statusMsg.badge}</div>
                ${statusMsg.body}
              </div>

              <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border-radius:10px;border:1px solid #e5e7eb;margin-bottom:24px">
                <tr>
                  <td style="padding:16px 20px">
                    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#9ca3af;margin-bottom:12px">Datos del cliente</div>
                    <div>👤 ${contact.name || '—'}</div>
                    <div>📧 ${contact.email || '—'}</div>
                    <div>📱 ${contact.phone || '—'}</div>
                    <div>📍 ${[contact.street, contact.city, contact.province].filter(Boolean).join(', ') || '—'}</div>
                  </td>
                </tr>
              </table>

              <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#9ca3af;margin-bottom:12px">Productos</div>

              <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;margin-bottom:20px">
                <thead>
                  <tr style="background:#f3f4f6">
                    <th style="padding:10px 12px;text-align:left;font-size:12px;color:#6b7280">Producto</th>
                    <th style="padding:10px 12px;text-align:center;font-size:12px;color:#6b7280">Cant.</th>
                    <th style="padding:10px 12px;text-align:right;font-size:12px;color:#6b7280">Precio</th>
                    <th style="padding:10px 12px;text-align:right;font-size:12px;color:#6b7280">Subtotal</th>
                  </tr>
                </thead>
                <tbody>${productosHtml}</tbody>
              </table>

              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px">
                <tr>
                  <td style="font-size:14px;color:#6b7280">Subtotal</td>
                  <td style="font-size:14px;color:#111827;text-align:right">${money(pedido.subtotal)}</td>
                </tr>
                <tr>
                  <td style="font-size:14px;color:#6b7280">Envío</td>
                  <td style="font-size:14px;color:#111827;text-align:right">
                    ${Number(pedido.deliveryCost || 0) === 0 ? '<span style="color:#16a34a">Gratis</span>' : money(pedido.deliveryCost)}
                  </td>
                </tr>
                <tr>
                  <td style="font-size:18px;font-weight:800;color:#111827;padding-top:12px">Total</td>
                  <td style="font-size:18px;font-weight:800;color:#f59e0b;text-align:right;padding-top:12px">${money(pedido.total)}</td>
                </tr>
              </table>

              ${tipo === 'cliente' ? `
              <div style="text-align:center">
                <a href="${whatsLink}" style="display:inline-block;background:#25d366;color:#fff;font-weight:700;font-size:14px;text-decoration:none;padding:14px 32px;border-radius:50px">
                  💬 Contactarnos por WhatsApp
                </a>
              </div>` : ''}
            </td>
          </tr>

          <tr>
            <td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:20px 32px;text-align:center">
              <div style="font-size:12px;color:#9ca3af">
                Lobo24 · Sarmiento 322, Resistencia, Chaco<br>
                <a href="https://wa.me/${STORE_WHATSAPP}" style="color:#f59e0b;text-decoration:none">+54 362 423-5455</a>
              </div>
            </td>
          </tr>
        </table>
      </td></tr>
    </table>
  </body>
  </html>`;
}

async function enviarEmailsPedido(pedido) {
  if (!process.env.BREVO_API_KEY) {
    console.warn('⚠️ Falta BREVO_API_KEY. No se enviaron emails.');
    return;
  }

  const clienteEmail = pedido.contact?.email;
  const orderNum = pedido.orderId || pedido.orderNumber || '';
  const sender = { name: FROM_NAME, email: FROM_EMAIL };

  const emails = [];

  if (clienteEmail) {
    emails.push({
      sender,
      to: [{ email: clienteEmail, name: pedido.contact?.name || '' }],
      subject: `Lobo24 — Tu pedido #${orderNum} fue recibido 🐺`,
      htmlContent: buildPedidoEmailHtml(pedido, 'cliente')
    });
  }

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

app.post('/crear-preferencia', async (req, res) => {
  try {
    const { items, customerData, orderData } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'No hay productos' });
    }

    const totalFinal = Number(orderData?.total);

    if (!totalFinal || totalFinal <= 0 || isNaN(totalFinal)) {
      return res.status(400).json({
        error: 'Total inválido para Mercado Pago',
        orderData
      });
    }

    const externalReference =
      orderData.orderId ||
      orderData.orderNumber ||
      `LOBO-${Date.now()}`;

    const preference = new Preference(mpClient);

    const result = await preference.create({
      body: {
        items: [
          {
            id: externalReference,
            title: `Pedido Lobo24 ${externalReference}`,
            quantity: 1,
            unit_price: totalFinal,
            currency_id: 'ARS'
          }
        ],
        payer: {
          name: customerData.name,
          email: customerData.email,
          phone: { number: customerData.phone }
        },
        external_reference: externalReference,
        statement_descriptor: 'LOBO24',
        back_urls: {
          success: `${FRONTEND_URL}/checkout.html?mp_status=success&order=${externalReference}`,
          failure: `${FRONTEND_URL}/checkout.html?mp_status=failure&order=${externalReference}`,
          pending: `${FRONTEND_URL}/checkout.html?mp_status=pending&order=${externalReference}`
        },
        auto_return: 'approved',
        notification_url: `${BACKEND_URL}/webhook`
      }
    });

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

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const { type, data } = req.body;

    if (type !== 'payment' || !data?.id) return;

    const payment = new Payment(mpClient);
    const payInfo = await payment.get({ id: data.id });

    const status = payInfo.status;
    const orderId = payInfo.external_reference;

    const pedido = await buscarPedidoPorOrderId(orderId);
    if (!pedido) return;

    if (status === 'approved') {
      await firestorePatch('pedidos', pedido.docId, {
        status: 'payment_confirmed',
        mpPaymentId: String(data.id)
      });

      await enviarEmailsPedido({
        ...pedido,
        status: 'payment_confirmed',
        mpPaymentId: String(data.id)
      });

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

app.listen(PORT, () => {
  console.log(`🚀 Servidor en http://localhost:${PORT}`);
});