const express = require('express');
const { createBeneficiary, createPaymentOrder } = require('./epagosService');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('API de Integración con EPAGOS está en funcionamiento.');
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
    console.log(`Asegúrate de tener el archivo .env configurado correctamente y el certificado PFX en la raíz.`);
});