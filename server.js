const express = require('express');
const cors = require('cors');
require('dotenv').config();

const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const { Resend } = require('resend');

const app = express();
const PORT = process.env.PORT || 3000;

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

const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN
});

const resend = new Resend(process.env.RESEND_API_KEY);
const SELLER_EMAIL = process.env.SELLER_EMAIL || 'marketlobo24@gmail.com';
const FROM_EMAIL = process.env.FROM_EMAIL || 'Lobo24 <onboarding@resend.dev>';

const FIREBASE_PROJECT = process.env.FIREBASE_PROJECT;
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;

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

function extraerValor(v) {
  if (!v) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.integerValue !== undefined) return Number(v.integerValue);
  if (v.doubleValue !== undefined) return Number(v.doubleValue);
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.timestampValue !== undefined) return v.timestampValue;
  if (v.nullValue !== undefined) return null;

  if (v.arrayValue) {
    return (v.arrayValue.values || []).map(extraerValor);
  }

  if (v.mapValue) {
    return extraerCampos(v.mapValue.fields || {});
  }

  return null;
}

function extraerCampos(fields) {
  const result = {};
  for (const [k, v] of Object.entries(fields || {})) {
    result[k] = extraerValor(v);
  }
  return result;
}

function convertirAFirestore(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v)
      ? { integerValue: String(v) }
      : { doubleValue: v };
  }
  if (typeof v === 'boolean') return { booleanValue: v };

  if (Array.isArray(v)) {
    return { arrayValue: { values: v.map(convertirAFirestore) } };
  }

  if (typeof v === 'object') {
    const fields = {};
    for (const [key, value] of Object.entries(v)) {
      fields[key] = convertirAFirestore(value);
    }
    return { mapValue: { fields } };
  }

  return { stringValue: String(v) };
}

async function firestoreGet(collectionName, docId) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${collectionName}/${docId}?key=${FIREBASE_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return await res.json();
}

async function firestorePatch(collectionName, docId, fields) {
  const updateMask = Object.keys(fields)
    .map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
    .join('&');

  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${collectionName}/${docId}?${updateMask}&key=${FIREBASE_API_KEY}`;

  const firestoreFields = {};
  for (const [k, v] of Object.entries(fields)) {
    firestoreFields[k] = convertirAFirestore(v);
  }

  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: firestoreFields })
  });

  if (!res.ok) {
    console.error('❌ Firestore PATCH error:', await res.text());
  }

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

  if (!res.ok) {
    console.error('❌ Error buscando pedido:', await res.text());
    return null;
  }

  const data = await res.json();
  if (!data || !data[0] || !data[0].document) return null;

  const doc = data[0].document;
  const docId = doc.name.split('/').pop();

  return { docId, ...extraerCampos(doc.fields) };
}

function buildPedidoEmailHtml(pedido, tipo = 'cliente') {
  const items = pedido.items || [];
  const contact = pedido.contact || {};

  const productosHtml = items.map(item => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #eee">${item.name || ''}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;text-align:center">${item.qty || 1}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;text-align:right">${money(item.price)}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;text-align:right">${money(item.subtotal || Number(item.price || 0) * Number(item.qty || 1))}</td>
    </tr>
  `).join('');

  return `
    <div style="font-family:Arial,sans-serif;background:#f6f6f6;padding:24px;color:#222">
      <div style="max-width:680px;margin:auto;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e5e5e5">
        <div style="background:#111827;color:#fff;padding:22px">
          <h1 style="margin:0;font-size:26px">LOBO24</h1>
          <p style="margin:6px 0 0">${tipo === 'vendedor' ? 'Nuevo pedido recibido' : 'Confirmación de compra'}</p>
        </div>

        <div style="padding:22px">
          <h2 style="margin-top:0">Pedido #${pedido.orderId || pedido.docId || ''}</h2>

          <p><strong>Cliente:</strong> ${contact.name || '—'}</p>
          <p><strong>Email:</strong> ${contact.email || '—'}</p>
          <p><strong>Teléfono:</strong> ${contact.phone || '—'}</p>
          <p><strong>Dirección:</strong> ${(contact.street || '')}, ${(contact.city || '')}, ${(contact.province || '')}</p>
          <p><strong>Notas:</strong> ${contact.notes || '—'}</p>

          <hr style="border:none;border-top:1px solid #eee;margin:18px 0">

          <p><strong>Pago:</strong> ${paymentLabel(pedido.payment)}</p>
          <p><strong>Entrega:</strong> ${deliveryLabel(pedido.delivery)}</p>
          <p><strong>Estado:</strong> ${pedido.status || '—'}</p>

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
            ${Number(pedido.pointsUsed || 0) > 0 ? `<p><strong>Descuento puntos:</strong> -${money(pedido.pointsUsed)}</p>` : ''}
            <h2 style="margin-bottom:0">Total: ${money(pedido.total)}</h2>
          </div>
        </div>
      </div>
    </div>
  `;
}

async function enviarEmailsPedido(pedido) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('⚠️ Falta RESEND_API_KEY. No se enviaron emails.');
    return;
  }

  const clienteEmail = pedido.contact?.email;
  const emails = [];

  if (clienteEmail) {
    emails.push({
      from: FROM_EMAIL,
      to: [clienteEmail],
      subject: `Confirmación de compra Lobo24 #${pedido.orderId || ''}`,
      html: buildPedidoEmailHtml(pedido, 'cliente')
    });
  }

  emails.push({
    from: FROM_EMAIL,
    to: [SELLER_EMAIL],
    subject: `Nuevo pedido Lobo24 #${pedido.orderId || ''}`,
    html: buildPedidoEmailHtml(pedido, 'vendedor')
  });

  for (const email of emails) {
    const { error } = await resend.emails.send(email);
    if (error) {
      console.error('❌ Error enviando email:', error);
    } else {
      console.log('📩 Email enviado:', email.to.join(', '));
    }
  }
}

async function descontarStockPedido(pedido) {
  const items = pedido.items || [];

  for (const item of items) {
    const col = item.coleccion;
    const docId = item.docId;
    const qty = Number(item.qty || 1);
    const stockOriginal = item.stockOriginal;

    if (!col || !docId || stockOriginal === null || stockOriginal === undefined) {
      console.warn('⚠️ Item sin datos de stock:', item);
      continue;
    }

    const nuevoStock = Math.max(0, Number(stockOriginal) - qty);
    const ok = await firestorePatch(col, docId, { stock: nuevoStock });

    if (ok) {
      console.log(`📦 Stock descontado: ${item.name} | ${stockOriginal} → ${nuevoStock}`);
    } else {
      console.warn(`⚠️ No se pudo descontar stock: ${item.name}`);
    }
  }
}

async function actualizarPuntosPedido(pedido) {
  const userId = pedido.userId;
  if (!userId) return;

  const userDoc = await firestoreGet('users', userId);
  if (!userDoc?.fields) return;

  const user = extraerCampos(userDoc.fields);
  const currentPoints = Number(user.points || 0);
  const pointsUsed = Number(pedido.pointsUsed || 0);
  const pointsEarned = Number(pedido.pointsEarned || 0);
  const newPoints = Math.max(0, currentPoints - pointsUsed + pointsEarned);

  await firestorePatch('users', userId, { points: newPoints });
  console.log(`⭐ Puntos actualizados: ${currentPoints} → ${newPoints}`);
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Servidor Lobo24 funcionando!' });
});

app.post('/crear-preferencia', async (req, res) => {
  try {
    const { items, customerData, orderData } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'No hay productos' });
    }

    console.log('📦 BODY RECIBIDO:', JSON.stringify(req.body, null, 2));

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

    const mpItems = [{
      id: externalReference,
      title: `Pedido Lobo24 ${externalReference}`,
      quantity: 1,
      unit_price: totalFinal,
      currency_id: 'ARS'
    }];

    const preference = new Preference(mpClient);

    const result = await preference.create({
      body: {
        items: mpItems,
        payer: {
          name: customerData?.name || '',
          email: customerData?.email || '',
          phone: { number: customerData?.phone || '' }
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

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const { type, data } = req.body;

    if (type !== 'payment' || !data?.id) return;

    const payment = new Payment(mpClient);
    const payInfo = await payment.get({ id: data.id });

    const status = payInfo.status;
    const orderId = payInfo.external_reference;

    console.log('💳 Pago:', status, '| Orden:', orderId);

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

      const pedidoActualizado = {
        ...pedido,
        status: 'payment_confirmed',
        mpPaymentId: String(data.id)
      };

      await descontarStockPedido(pedidoActualizado);
      await actualizarPuntosPedido(pedidoActualizado);
      await enviarEmailsPedido(pedidoActualizado);

      console.log('✅ Pedido aprobado, stock descontado, puntos actualizados y emails enviados');

    } else if (status === 'rejected') {
      await firestorePatch('pedidos', pedido.docId, {
        status: 'cancelled',
        mpPaymentId: String(data.id)
      });

    } else if (status === 'pending' || status === 'in_process') {
      await firestorePatch('pedidos', pedido.docId, {
        status: 'pending_payment',
        mpPaymentId: String(data.id)
      });
    }

  } catch (err) {
    console.error('❌ Error webhook:', err);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor en http://localhost:${PORT}`);
});