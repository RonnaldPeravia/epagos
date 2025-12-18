const express = require('express');
const cron = require('node-cron');
const { createBeneficiary, createPaymentOrder, checkBeneficiaryRelationshipExists } = require('./epagosService');
const { processPendingPayments } = require('./paymentWorker');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Variable global para evitar ejecuciones solapadas
let isProcessing = false;

// --- CRON JOB ---
// Se ejecuta cada 5 minutos
cron.schedule('*/30 10 * * * *', async () => {
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
        const companyId = process.env.BUSINESS_PARTNER_1_ID;

        // --- PASO 1: VERIFICAR PRIMERO ---
        console.log("Verificando si el beneficiario ya existe...");
        const alreadyExists = await checkBeneficiaryRelationshipExists(
            companyId,
            beneficiaryInfo.identityType,
            beneficiaryInfo.identityNumber
        );

        // --- PASO 2: MANEJAR EL CASO "YA EXISTE" ---
        if (alreadyExists) {
            console.log("Respuesta: El beneficiario ya existe. Finalizando.");
            // Devolvemos 200 OK, no 201 Created.
            return res.status(200).json({ success: true, message: "El beneficiario ya existe y está vinculado a la empresa." });
        }

        // --- PASO 3: INTENTAR LA CREACIÓN ASÍNCRONA ---
        // Si llegamos aquí, el beneficiario no existe.
        try {
            // Llamamos a la función simplificada que solo hace el POST.
            await createBeneficiary(beneficiaryInfo);
        } catch (error) {
            if (error.message.includes("Contenido: undefined") || error.message.includes("read ECONNRESET")) {
                console.log("Se inició la creación asíncrona. Se procederá a verificar...");
            } else {
                // Si es un error real, lo lanzamos.
                throw error;
            }
        }

        // --- PASO 4: SONDEO (POLLING) PARA VERIFICAR LA CREACIÓN ---
        let isCreated = false;
        const maxRetries = 5;
        const retryDelay = 10000;

        for (let i = 0; i < maxRetries; i++) {
            console.log(`Intento de verificación #${i + 1} de ${maxRetries}...`);
            await delay(retryDelay);

            const relationshipExists = await checkBeneficiaryRelationshipExists(
                companyId,
                beneficiaryInfo.identityType,
                beneficiaryInfo.identityNumber
            );

            if (relationshipExists) {
                isCreated = true;
                break;
            }
        }

        // --- PASO 5: DEVOLVER RESPUESTA FINAL ---
        if (isCreated) {
            res.status(201).json({ success: true, message: "Beneficiario creado y verificado exitosamente." });
        } else {
            res.status(504).json({ success: false, message: "Se solicitó la creación, pero no se pudo verificar su estado final." });
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
    // console.log(`Cron Job programado: */30 * * * * *`);
});