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

// Función de utilidad para esperar
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Endpoint para crear un nuevo beneficiario.
 * Sigue el flujo completo de 3 pasos.
 */
app.post('/api/beneficiaries', async (req, res) => {
    try {
        const beneficiaryInfo = req.body;

        // Paso 1: Intentamos la creación. ESPERAMOS que pueda fallar con el error 'undefined'.
        try {
            // No necesitamos el resultado aquí, es solo para iniciar el proceso
            await createBeneficiary(beneficiaryInfo);
        } catch (error) {
            // Si el error es el que esperamos, lo ignoramos y continuamos.
            if (error.message.includes("Contenido: undefined")) {
                console.log("Se inició la creación asíncrona. Se procederá a verificar...");
            } else {
                // Si es otro error, sí lo lanzamos.
                throw error;
            }
        }

        // Paso 2: Sondeo (Polling). Esperamos un poco y empezamos a verificar.
        let isCreated = false;
        const maxRetries = 5; // Intentar 5 veces
        const retryDelay = 10000; // Esperar 10 segundos entre intentos

        for (let i = 0; i < maxRetries; i++) {
            console.log(`Intento de verificación #${i + 1}...`);
            await delay(retryDelay); // Esperar

            // Usamos la función de verificación que ya tenemos
            const relationshipExists = await checkBeneficiaryRelationshipExists(
                process.env.BUSINESS_PARTNER_1_ID,
                beneficiaryInfo.identityType,
                beneficiaryInfo.identityNumber
            );

            if (relationshipExists) {
                isCreated = true;
                break; // Si se encuentra, salimos del bucle
            }
        }

        // Paso 3: Devolver la respuesta final
        if (isCreated) {
            res.status(201).json({ success: true, message: "Beneficiario creado y verificado exitosamente." });
        } else {
            res.status(500).json({ success: false, message: "Se solicitó la creación del beneficiario, pero no se pudo verificar su estado final después de varios intentos." });
        }

    } catch (error) {
        res.status(500).json({ success: false, message: "Fallo al procesar el beneficiario.", details: error.message });
    }
});

/**
 * Endpoint para crear una orden de pago.
 */
app.post('/api/payments', async (req, res) => {
    try {
        const result = await createPaymentOrder(req.body);
        res.status(201).json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Fallo al procesar la orden de pago.",
            details: error.message
        });
    }
});

app.listen(PORT, () => {
    console.log(`Servidor escuchando en el puerto ${PORT}`);
    console.log(`Cron Job programado: */5 * * * *`);
});