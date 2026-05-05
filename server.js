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

// ===================== BREVO (EMAILS) =====================
const brevo = require('@getbrevo/brevo');
let brevoApiInstance = new brevo.TransactionalEmailsApi();
brevoApiInstance.setApiKey(brevo.TransactionalEmailsApiApiKeys.apiKey, process.env.BREVO_API_KEY);

const BREVO_SENDER = {
    name: process.env.BREVO_SENDER_NAME || 'Lobo24',
    email: process.env.BREVO_SENDER_EMAIL || 'onboarding@resend.dev'
};
const SELLER_EMAIL = process.env.SELLER_EMAIL || 'marketlobo24@gmail.com';

// ===================== FIREBASE =====================

const FIREBASE_PROJECT  = process.env.FIREBASE_PROJECT;
const FIREBASE_API_KEY  = process.env.FIREBASE_API_KEY;

// Obtener doc
async function firestoreGet(collection, docId) {
    const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${collection}/${docId}?key=${FIREBASE_API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
}

// Actualizar doc
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

// Buscar pedido
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

// Convertir campos
function extraerCampos(fields) {
    if (!fields) return {};
    const result = {};

    for (const [k, v] of Object.entries(fields)) {
        if (v.stringValue !== undefined) result[k] = v.stringValue;
        else if (v.integerValue !== undefined) result[k] = Number(v.integerValue);
        else if (v.doubleValue !== undefined) result[k] = Number(v.doubleValue);
        else if (v.booleanValue !== undefined) result[k] = v.booleanValue;
        else if (v.arrayValue !== undefined) {
            // Manejar arrays si es necesario
            result[k] = v.arrayValue.values || [];
        }
    }

    return result;
}

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
  if (delivery === 'domicilio_cerca') return 'Envío a domicilio ≤ 10 cuadras';
  if (delivery === 'domicilio_lejos') return 'Envío a domicilio > 10 cuadras';
  if (delivery === 'domicilio_prov') return 'Envío a otra provincia';
  return delivery || 'No informado';
}

function buildPedidoEmailHtml(pedido, tipo = 'cliente') {
  const items = pedido.items || [];
  const contact = pedido.contact || {};

  const productosHtml = items.length > 0 ? items.map(item => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #eee">${item.name || ''}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;text-align:center">${item.qty || 1}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;text-align:right">${money(item.price)}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;text-align:right">${money(item.subtotal || Number(item.price || 0) * Number(item.qty || 1))}</td>
    </tr>
  `).join('') : '<tr><td colspan="4" style="padding:12px;text-align:center">Sin productos</td></tr>';

  return `
    <div style="font-family:Arial,sans-serif;background:#f6f6f6;padding:24px;color:#222">
      <div style="max-width:680px;margin:auto;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e5e5e5">
        <div style="background:#111827;color:#fff;padding:22px">
          <h1 style="margin:0;font-size:26px">LOBO24</h1>
          <p style="margin:6px 0 0">${tipo === 'vendedor' ? '🛒 Nuevo pedido recibido' : '✅ Confirmación de tu compra'}</p>
        </div>

        <div style="padding:22px">
          <h2 style="margin-top:0">Pedido #${pedido.orderId || pedido.orderNumber || pedido.docId || ''}</h2>

          <p><strong>👤 Cliente:</strong> ${contact.name || '—'}</p>
          <p><strong>📧 Email:</strong> ${contact.email || '—'}</p>
          <p><strong>📱 Teléfono:</strong> ${contact.phone || '—'}</p>
          <p><strong>📍 Dirección:</strong> ${[contact.street, contact.city, contact.province].filter(Boolean).join(', ') || '—'}</p>
          ${contact.notes ? `<p><strong>📝 Notas:</strong> ${contact.notes}</p>` : ''}

          <hr style="border:none;border-top:1px solid #eee;margin:18px 0">

          <p><strong>💳 Pago:</strong> ${paymentLabel(pedido.payment)}</p>
          <p><strong>🚚 Entrega:</strong> ${deliveryLabel(pedido.delivery)}</p>
          <p><strong>📊 Estado:</strong> ${pedido.status || '—'}</p>

          <table style="width:100%;border-collapse:collapse;margin-top:18px">
            <thead>
              <tr style="background:#f3f4f6">
                <th style="padding:8px;text-align:left">Producto</th>
                <th style="padding:8px;text-align:center">Cant.</th>
                <th style="padding:8px;text-align:right">Precio</th>
                <th style="padding:8px;text-align:right">Subtotal</th>
              </tr>
            </thead>
            <tbody>${productosHtml}</tbody>
          </table>

          <div style="margin-top:18px;text-align:right">
            <p><strong>Subtotal:</strong> ${money(pedido.subtotal)}</p>
            <p><strong>Envío:</strong> ${Number(pedido.deliveryCost || 0) === 0 ? 'Gratis' : money(pedido.deliveryCost)}</p>
            ${Number(pedido.pointsUsed || 0) > 0 ? `<p><strong>⭐ Descuento puntos:</strong> -${money(pedido.pointsUsed)}</p>` : ''}
            <h2 style="margin-bottom:0">💰 Total: ${money(pedido.total)}</h2>
          </div>
          
          ${pedido.payment === 'transfer' ? `
          <div style="margin-top:20px;padding:15px;background:#fffbeb;border:1px solid #fcd34d;border-radius:8px">
            <p style="margin:0 0 6px;font-weight:700">📌 Completá tu pago por transferencia:</p>
            <p style="margin:4px 0;font-size:13px;">Alias: <strong>LOBO24.PAGO</strong></p>
            <p style="margin:4px 0;font-size:13px;">CBU: <strong>0110599920000012345678</strong></p>
            <p style="margin:4px 0;font-size:13px;">Monto exacto: <strong>${money(pedido.total)}</strong></p>
          </div>
          ` : ''}
        </div>
      </div>
    </div>
  `;
}

// Función para enviar email con Brevo
async function enviarEmailBrevo(destinatario, asunto, htmlContent) {
    try {
        const sendSmtpEmail = new brevo.SendSmtpEmail();
        sendSmtpEmail.sender = BREVO_SENDER;
        sendSmtpEmail.to = [{ email: destinatario }];
        sendSmtpEmail.subject = asunto;
        sendSmtpEmail.htmlContent = htmlContent;
        
        const response = await brevoApiInstance.sendTransacEmail(sendSmtpEmail);
        console.log(`📧 Email enviado a ${destinatario} | ID: ${response.messageId}`);
        return { success: true, messageId: response.messageId };
    } catch (error) {
        console.error(`❌ Error enviando email a ${destinatario}:`, error.message);
        return { success: false, error: error.message };
    }
}

async function enviarEmailsPedido(pedido) {
  if (!process.env.BREVO_API_KEY) {
    console.warn('⚠️ Falta BREVO_API_KEY. No se enviaron emails.');
    return;
  }

  const clienteEmail = pedido.contact?.email;
  const orderNum = pedido.orderId || pedido.orderNumber || pedido.docId || '';
  
  console.log('📧 Iniciando envío de emails para pedido:', orderNum);

  // Email al cliente
  if (clienteEmail && clienteEmail !== '') {
    await enviarEmailBrevo(
      clienteEmail,
      `✅ Compra confirmada en Lobo24 — Pedido #${orderNum}`,
      buildPedidoEmailHtml(pedido, 'cliente')
    );
  } else {
    console.warn('⚠️ Cliente sin email, no se envía confirmación');
  }

  // Email al vendedor
  await enviarEmailBrevo(
    SELLER_EMAIL,
    `🛒 Nuevo pedido en Lobo24 — #${orderNum} — ${money(pedido.total)}`,
    buildPedidoEmailHtml(pedido, 'vendedor')
  );
}

// ===================== RUTAS =====================

app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'Servidor Lobo24 funcionando!', email_service: 'Brevo' });
});

// Ruta de prueba para Brevo
app.post('/test-brevo', async (req, res) => {
    try {
        const result = await enviarEmailBrevo(
            SELLER_EMAIL,
            '✅ Test Lobo24 - Brevo funcionando',
            '<h1>¡Perfecto!</h1><p>Brevo está configurado correctamente en tu servidor.</p><p>Fecha: ' + new Date().toLocaleString() + '</p>'
        );
        res.json(result);
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// ===================== CREAR PREFERENCIA =====================

app.post('/crear-preferencia', async (req, res) => {
    try {
        const { items, customerData, orderData } = req.body;

        if (!items || items.length === 0) {
            return res.status(400).json({ error: 'No hay productos' });
        }

        console.log('📦 Creando preferencia para:', customerData?.email);

        const totalFinal = Number(orderData?.total);

        if (!totalFinal || totalFinal <= 0 || isNaN(totalFinal)) {
            console.error('❌ Total inválido:', orderData);
            return res.status(400).json({ error: 'Total inválido para Mercado Pago' });
        }

        const externalReference = orderData.orderId || orderData.orderNumber || `LOBO-${Date.now()}`;

        const preference = new Preference(mpClient);

        const result = await preference.create({
            body: {
                items: [{
                    id: externalReference,
                    title: `Pedido Lobo24 ${externalReference}`,
                    quantity: 1,
                    unit_price: totalFinal,
                    currency_id: 'ARS'
                }],
                payer: {
                    name: customerData?.name || '',
                    email: customerData?.email || '',
                    phone: { number: String(customerData?.phone || '') }
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

        console.log('✅ Preferencia creada:', result.id);
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

// ===================== WEBHOOK =====================

app.post('/webhook', async (req, res) => {
    res.sendStatus(200);

    try {
        const { type, data } = req.body;

        if (type !== 'payment' || !data?.id) return;

        const payment = new Payment(mpClient);
        const payInfo = await payment.get({ id: data.id });

        const status  = payInfo.status;
        const orderId = payInfo.external_reference;

        console.log('💳 Webhook - Pago:', status, '| Orden:', orderId);

        const pedido = await buscarPedidoPorOrderId(orderId);

        if (!pedido) {
            console.warn('⚠️ Pedido no encontrado:', orderId);
            return;
        }

        if (status === 'approved') {
            await firestorePatch('pedidos', pedido.docId, {
                status: 'payment_confirmed',
                mpPaymentId: String(data.id)
            });

            console.log('✅ Pedido confirmado:', orderId);
            
            // Enviar emails con Brevo
            await enviarEmailsPedido({
                ...pedido,
                status: 'payment_confirmed',
                mpPaymentId: String(data.id)
            });

        } else if (status === 'rejected') {
            await firestorePatch('pedidos', pedido.docId, {
                status: 'cancelled',
                mpPaymentId: String(data.id)
            });
            console.log('❌ Pago rechazado:', orderId);
        } else if (status === 'pending') {
            await firestorePatch('pedidos', pedido.docId, {
                status: 'pending_payment',
                mpPaymentId: String(data.id)
            });
            console.log('⏳ Pago pendiente:', orderId);
        }

    } catch (err) {
        console.error('❌ Error en webhook:', err.message);
    }
});

// Endpoint manual para enviar email (para transferencia/efectivo)
app.post('/enviar-email-pedido', async (req, res) => {
    try {
        const { pedido } = req.body;
        if (!pedido) {
            return res.status(400).json({ error: 'Falta el pedido' });
        }
        await enviarEmailsPedido(pedido);
        res.json({ ok: true, message: 'Emails enviados correctamente' });
    } catch(e) {
        console.error('❌ Error enviando email manual:', e);
        res.status(500).json({ error: 'Error al enviar email' });
    }
});

// ===================== START =====================

app.listen(PORT, () => {
    console.log(`\n🚀 Servidor Lobo24 corriendo en http://localhost:${PORT}`);
    console.log(`📦 Mercado Pago: ${process.env.MP_ACCESS_TOKEN ? '✅ Configurado' : '❌ Falta token'}`);
    console.log(`📧 Brevo: ${process.env.BREVO_API_KEY ? '✅ Configurado' : '❌ Falta API key'}`);
    console.log(`📧 Email vendedor: ${SELLER_EMAIL}`);
    console.log(`🌐 Frontend: ${process.env.FRONTEND_URL}`);
    console.log(`🔔 Webhook: ${process.env.BACKEND_URL}/webhook\n`);
});