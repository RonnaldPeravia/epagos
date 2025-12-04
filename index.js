const express = require('express');
const cron = require('node-cron');
const { createBeneficiary, createPaymentOrder } = require('./epagosService');
const { processPendingPayments } = require('./paymentWorker');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Variable global para evitar ejecuciones solapadas
let isProcessing = false;

// --- CRON JOB ---
// Se ejecuta cada 5 minutos
cron.schedule('*/5 * * * *', async () => {
    if (isProcessing) {
        console.log('⚠️ El ciclo anterior aún está corriendo. Saltando ejecución.');
        return;
    }

    isProcessing = true;
    try {
        await processPendingPayments();
    } catch (error) {
        console.error('Error no controlado en Cron:', error);
    } finally {
        isProcessing = false;
    }
});

// --- RUTAS API (Para pruebas manuales o UAT) ---
app.get('/', (req, res) => {
    res.send('Middleware SAP-EPAGOS activo. Cron Job corriendo cada 5 min.');
});

// Endpoint para forzar la ejecución manual del worker (útil para testing)
app.post('/api/trigger-sync', async (req, res) => {
    if (isProcessing) return res.status(409).json({ message: 'Proceso ya en ejecución' });
    
    // Ejecutar sin await para no bloquear response, o con await si queremos ver log
    isProcessing = true;
    processPendingPayments().then(() => {
        isProcessing = false;
    });
    
    res.json({ message: 'Sincronización iniciada manualmente.' });
});

/**
 * Endpoint para crear un nuevo beneficiario.
 * Sigue el flujo completo de 3 pasos.
 */
app.post('/api/beneficiaries', async (req, res) => {
    try {
        const beneficiaryInfo = req.body;
        // Aquí podrías añadir validaciones del cuerpo de la solicitud
        const result = await createBeneficiary(beneficiaryInfo);

        // Si el beneficiario ya existía, devolvemos un 200 OK con el mensaje.
        if (result.status === 'exists') {
            return res.status(200).json({ message: result.message });
        }

        // Si se creó una nueva relación, devolvemos 201 Created.
        res.status(201).json({ message: "Beneficiario creado/vinculado exitosamente.", data: result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Endpoint para crear una orden de pago.
 */
app.post('/api/payments', async (req, res) => {
    try {
        const paymentPayload = req.body;
        if (!paymentPayload || !paymentPayload.OrderItems?.length) {
            return res.status(400).json({ error: 'Payload de pago inválido.' });
        }
        const result = await createPaymentOrder(paymentPayload);
        const orderNumber = result.entry?.content['m:properties']['d:OrderNr'];
        res.status(201).json({ message: "Orden de pago creada exitosamente.", orderNumber: orderNumber, data: result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Servidor escuchando en el puerto ${PORT}`);
    console.log(`Cron Job programado: */5 * * * *`);
});