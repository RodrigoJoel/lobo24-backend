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
    }

    return result;
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

        const totalFinal = Number(orderData.total || 0);

        if (!totalFinal || totalFinal <= 0) {
            return res.status(400).json({ error: 'Total inválido para Mercado Pago' });
        }

        // 🔥 CLAVE: referencia única SIEMPRE
        const externalReference =
            orderData.orderId ||
            orderData.orderNumber ||
            `LOBO-${Date.now()}`;

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

        console.log('💳 Pago:', status, '| Orden:', orderId);

        const pedido = await buscarPedidoPorOrderId(orderId);

        if (!pedido) return;

        if (status === 'approved') {

            await firestorePatch('pedidos', pedido.docId, {
                status: 'payment_confirmed',
                mpPaymentId: String(data.id)
            });

            console.log('✅ Pedido aprobado');

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