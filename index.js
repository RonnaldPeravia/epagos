const express = require('express');
const { createBeneficiary, createPaymentOrder } = require('./epagosService');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('API de Integración con EPAGOS está en funcionamiento.');
});

// Endpoint para crear un nuevo beneficiario
app.post('/api/beneficiaries', async (req, res) => {
    try {
        // Aquí iría la validación del cuerpo de la solicitud (req.body)
        const beneficiaryInfo = req.body;
        const result = await createBeneficiary(beneficiaryInfo);
        res.status(201).json({ message: "Beneficiario creado exitosamente.", data: result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Endpoint para crear una orden de pago
app.post('/api/payments', async (req, res) => {
    try {
        const paymentPayload = req.body;
        // Validar el payload
        if (!paymentPayload || !paymentPayload.OrderItems || paymentPayload.OrderItems.length === 0) {
            return res.status(400).json({ error: 'Payload de pago inválido.' });
        }
        const result = await createPaymentOrder(paymentPayload);
        // Extraer el número de orden de la respuesta parseada
        const orderNumber = result.entry?.content['m:properties']['d:OrderNr'];
        res.status(201).json({ message: "Orden de pago creada exitosamente.", orderNumber: orderNumber, data: result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Servidor escuchando en el puerto ${PORT}`);
    console.log(`Asegúrate de tener el archivo .env configurado correctamente.`);
});