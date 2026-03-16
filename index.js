const express = require('express');
const cron = require('node-cron');
const {
    createBeneficiary,
    createPaymentOrder,
    checkBeneficiaryRelationshipExists,
    getBeneficiaryBankAccounts,
    getPaymentOrderStatus,
    findGlobalBeneficiary,
    checkBeneficiaryRelationship,
    getCsrfToken,
    addBankAccountToBeneficiary
} = require('./epagosService');
const { processPendingPayments } = require('./paymentWorker');
const sapService = require('./sapService');
const { mapSapPaymentToEPagosDTO } = require('./mappers/paymentMapper');
require('dotenv').config();

const { runVendorPaymentsTestFlow } = require('./flows/vendorPaymentsTestFlow');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Variable global para evitar ejecuciones solapadas
let isProcessing = false;

// --- CRON JOB ---
// Se ejecuta cada minuto
cron.schedule('0 * * * * *', async () => {
    if (isProcessing) {
        console.log('⚠️ El ciclo anterior aún está corriendo. Saltando ejecución.');
        return;
    }

    isProcessing = true;
    try {
        const result = await runVendorPaymentsTestFlow({
            filter: null, 
            top: null,
            skip: null
        });

        console.log('Resultado:', result);
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

// --- Grupo 1: BENEFICIARIOS ---

// 1. Consulta Global de Beneficiario
app.get('/api/unit-test/beneficiaries/find-global', async (req, res) => {
    try {
        const { identityType, identityNumber } = req.query;
        if (!identityType || !identityNumber) return res.status(400).json({ error: "Parámetros 'identityType' y 'identityNumber' son requeridos." });

        const beneficiaryId = await findGlobalBeneficiary(identityType, identityNumber);
        if (beneficiaryId) {
            res.status(200).json({ found: true, message: "Beneficiario encontrado globalmente.", beneficiaryId });
        } else {
            res.status(404).json({ found: false, message: "Beneficiario no encontrado globalmente." });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: "Error en la consulta global.", details: error.message });
    }
});

// 2. Verificar Relación con la Empresa
app.get('/api/unit-test/beneficiaries/:beneficiaryId/check-relationship', async (req, res) => {
    try {
        const { beneficiaryId } = req.params;
        const companyId = process.env.BUSINESS_PARTNER_1_ID;
        if (!companyId) throw new Error("BUSINESS_PARTNER_1_ID no está configurado.");

        const exists = await checkBeneficiaryRelationship(companyId, beneficiaryId);
        res.status(200).json({
            relationshipExists: exists,
            message: exists ? "La relación entre la empresa y el beneficiario SÍ existe." : "La relación entre la empresa y el beneficiario NO existe."
        });
    } catch (error) {
        res.status(500).json({ success: false, message: "Error al verificar la relación.", details: error.message });
    }
});

// 3. Verificación Completa (Combo)
app.get('/api/unit-test/beneficiaries/exists-in-company', async (req, res) => {
    try {
        const { identityType, identityNumber } = req.query;
        if (!identityType || !identityNumber) return res.status(400).json({ error: "Parámetros 'identityType' y 'identityNumber' son requeridos." });

        const exists = await checkBeneficiaryRelationshipExists(process.env.BUSINESS_PARTNER_1_ID, identityType, identityNumber);
        res.status(200).json({
            existsInCompany: exists,
            message: exists ? "El beneficiario SÍ existe y está vinculado a la empresa." : "El beneficiario NO existe o NO está vinculado a la empresa."
        });
    } catch (error) {
        res.status(500).json({ success: false, message: "Error en la verificación completa.", details: error.message });
    }
});

// 4. Crear Nuevo Beneficiario
app.post('/api/unit-test/beneficiaries/create', async (req, res) => {
    try {
        const payload = req.body;
        if (!payload.BusinessPartner2) return res.status(400).json({ error: "El payload debe contener el objeto 'BusinessPartner2' para la creación." });

        const result = await createBeneficiary(payload);
        res.status(201).json({ success: true, message: "Solicitud de CREACIÓN enviada.", result });
    } catch (error) {
        res.status(500).json({ success: false, message: "Error al intentar crear el beneficiario.", details: error.message });
    }
});

// 5. Vincular Beneficiario Existente
app.post('/api/unit-test/beneficiaries/link', async (req, res) => {
    try {
        const payload = req.body;
        if (!payload.BusinessPartner2Id) {
            return res.status(400).json({ error: "El payload debe contener la propiedad 'BusinessPartner2Id' para la vinculación." });
        }

        // --- CORRECIÓN ---
        // Pasamos la variable 'payload' a la función createBeneficiary.
        const result = await createBeneficiary(payload);

        res.status(201).json({ success: true, message: "Solicitud de VINCULACIÓN enviada.", result });
    } catch (error) {
        res.status(500).json({ success: false, message: "Error al intentar vincular el beneficiario.", details: error.message });
    }
});

app.get('/api/unit-test/sap/vendor-payments', async (req, res) => {
    try {
        const { filter, select, top, skip } = req.query;

        await sapService.login();

        const data = await sapService.listVendorPayments({
            filter,
            select,
            top: Number(top),
            skip: Number(skip)
        });

        await sapService.logout();

        res.json({ count: data.length, data });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/unit-test/sap/vendor-payments-bp', async (req, res) => {
    try {
        const { filter, select, top, skip } = req.query;

        await sapService.login();

        const data = await sapService.listVendorPaymentsWithBP({
            filter,
            select,
            top: Number(top) || 20,
            skip: Number(skip) || 0
        });

        await sapService.logout();

        res.json({
            count: data.length,
            data
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/unit-test/sap/vendor-payments-epagos', async (req, res) => {
    try {
        const { filter, top, skip } = req.query;

        await sapService.login();

        const payments = await sapService.listVendorPaymentsWithBP({
            filter,
            top: Number(top),
            skip: Number(skip)
        });

        await sapService.logout();

        const mapped = payments.map(mapSapPaymentToEPagosDTO);

        res.json({
            count: mapped.length,
            data: mapped
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/unit-test/sap/update-vendor-payments-error/:docEntry', async (req, res) => {
    try {
        const { docEntry } = req.params;

        await sapService.login();

        await sapService.updatePaymentStatus(docEntry, req.body);

        await sapService.logout();

        res.json({
            success: true,
            message: `Vendor payment ${docEntry} updated`
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * PRUEBA UNITARIA: Añade una cuenta a un beneficiario ya vinculado.
 * POST /api/unit-test/beneficiaries/:beneficiaryId/add-account
 */
app.post('/api/unit-test/beneficiaries/:beneficiaryId/add-account', async (req, res) => {
    try {
        const { beneficiaryId } = req.params;
        const accountInfo = req.body; // El body contendrá { bankId, accountType, ... }

        const result = await addBankAccountToBeneficiary(beneficiaryId, accountInfo);
        res.status(201).json(result);
    } catch (error) {
        res.status(500).json({ success: false, message: "Error al añadir la cuenta.", details: error.message });
    }
});


// --- Grupo 2: ÓRDENES DE PAGO ---

// 7 & 8. Crear una Orden de Pago (Simple o Múltiple)
app.post('/api/unit-test/payments/create', async (req, res) => {
    try {
        const payload = req.body;
        if (!payload.OrderItems || payload.OrderItems.length === 0) return res.status(400).json({ error: "El payload debe contener un array 'OrderItems' con al menos un elemento." });

        const result = await createPaymentOrder(payload);
        res.status(201).json({ success: true, message: "Solicitud de orden de pago enviada.", result });
    } catch (error) {
        res.status(500).json({ success: false, message: "Error al crear la orden de pago.", details: error.message });
    }
});

// 9. Consultar Estado de una Orden de Pago
app.get('/api/unit-test/payments/:orderNumber', async (req, res) => {
    try {
        const { orderNumber } = req.params;
        const result = await getPaymentOrderStatus(orderNumber);
        res.status(200).json({ success: true, orderStatus: result });
    } catch (error) {
        res.status(500).json({ success: false, message: "Error al consultar el estado de la orden.", details: error.message });
    }
});


// --- Grupo 3: TOKEN Y SESIÓN ---

// 10. Obtener Token CSRF
app.get('/api/unit-test/session/get-token', async (req, res) => {
    try {
        const result = await getCsrfToken();
        res.status(200).json({ success: true, message: "Token y cookie obtenidos exitosamente.", ...result });
    } catch (error) {
        res.status(500).json({ success: false, message: "Error al obtener el token CSRF.", details: error.message });
    }
});

/**
 * Endpoint para crear un nuevo beneficiario.
 * Sigue el flujo completo de 3 pasos.
 */
app.post('/api/beneficiaries', async (req, res) => {
    try {
        const beneficiaryInfo = req.body;
        const companyId = process.env.BUSINESS_PARTNER_1_ID;

        // --- PASO 1: VERIFICAR PRIMERO (usando funciones de bajo nivel) ---
        console.log("Verificando si el beneficiario ya existe...");
        const beneficiaryId = await findGlobalBeneficiary(beneficiaryInfo.identityType, beneficiaryInfo.identityNumber);

        if (beneficiaryId) {
            const relationshipExists = await checkBeneficiaryRelationship(companyId, beneficiaryId);
            if (relationshipExists) {
                console.log("Respuesta: El beneficiario ya existe y está vinculado.");
                return res.status(200).json({ success: true, message: "El beneficiario ya existe y está vinculado a la empresa." });
            }
        }

        // --- PASO 2: CONSTRUIR EL PAYLOAD CON LOS NOMBRES CORRECTOS (PascalCase) ---
        const payload = {
            "RelationshipTypeId": "ZBUBA6",
            "ZBUBA6Data": {
                "PaymentOptions": [{
                    "BankAccount": { "BankId": beneficiaryInfo.bankId, "AccountTypeId": beneficiaryInfo.accountType, "BankAccountNr": beneficiaryInfo.accountNumber },
                    "MethodId": beneficiaryInfo.methodId, "CurrencyId": "DOP"
                }]
            }
        };

        if (beneficiaryId) {
            payload.BusinessPartner2Id = beneficiaryId;
        } else {
            payload.BusinessPartner2 = {
                "IdentityTypeId": beneficiaryInfo.identityType,
                "IdentityNr": beneficiaryInfo.identityNumber,
                "BusinessPartnerTypeId": "1",
                "Name1": beneficiaryInfo.name
            };
        }

        // --- PASO 3: INTENTAR LA CREACIÓN ASÍNCRONA ---
        try {
            await createBeneficiary(payload); // Llamamos a la función 'tonta' con el payload ya construido
        } catch (error) {
            if (error.message.includes("Respuesta vacía del servidor") || error.message.includes("ECONNRESET")) {
                console.log("Se inició la creación asíncrona. Se procederá a verificar...");
            } else {
                throw error; // Si es un error real, lo lanzamos
            }
        }

        // --- PASO 4: SONDEO (POLLING) PARA VERIFICAR LA CREACIÓN ---
        let isCreated = false;
        const maxRetries = 5;
        const retryDelay = 10000; // 10 segundos

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
 * Verifica si un beneficiario existe y está vinculado.
 * GET /api/beneficiaries/check?identityType=DORN&identityNumber=101813733
 */
app.get('/api/beneficiaries/check', async (req, res) => {
    try {
        const { identityType, identityNumber } = req.query;
        if (!identityType || !identityNumber) {
            return res.status(400).json({ error: "Parámetros 'identityType' y 'identityNumber' son requeridos." });
        }
        const exists = await checkBeneficiaryRelationshipExists(process.env.BUSINESS_PARTNER_1_ID, identityType, identityNumber);
        res.status(200).json({ exists });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/unit-test/sap/vendor-payments-epagos/run-flow', async (req, res) => {

    try {

        const { filter, top, skip } = req.query;

        const result = await runVendorPaymentsTestFlow({
            filter,
            top,
            skip
        });

        res.json({
            success: true,
            ...result
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            error: error.message
        });

    }

});

/**
 * Consulta las cuentas bancarias de un beneficiario.
 * GET /api/beneficiaries/:beneficiaryId/accounts
 * Nota: beneficiaryId es el ID de ePagos (ej. 600008532), no el RNC.
 */
app.get('/api/unit-test/beneficiaries/:beneficiaryId/accounts', async (req, res) => {
    try {
        const { beneficiaryId } = req.params;
        const accounts = await getBeneficiaryBankAccounts(process.env.BUSINESS_PARTNER_1_ID, beneficiaryId);
        res.status(200).json(accounts);
    } catch (error) {
        res.status(500).json({ error: error.message });
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

/**
 * Consulta el estado de una orden de pago.
 * GET /api/payments/:orderNumber
 */
app.get('/api/payments/:orderNumber', async (req, res) => {
    try {
        const { orderNumber } = req.params;
        const status = await getPaymentOrderStatus(orderNumber);
        res.status(200).json(status);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/unit-test/sap/vendor-payments-epagos/validate', async (req, res) => {
    try {

        const { filter, top, skip } = req.query;

        await sapService.login();

        // 1️⃣ Obtener pagos crudos desde SAP
        const payments = await sapService.listVendorPaymentsWithBP({
            filter,
            top: Number(top),
            skip: Number(skip)
        });

        // 2️⃣ Mapear a tu DTO
        const mapped = payments.map(mapSapPaymentToEPagosDTO);

        const validPayments = [];
        const paymentsWithError = [];

        // 3️⃣ Separar pagos
        for (const payment of mapped) {

            const errorMessage = getBankDataError(payment);

            if (errorMessage) {

                paymentsWithError.push({
                    DocEntry: payment.DocEntry,
                    message: errorMessage
                });

            } else {
                validPayments.push(payment);
            }
        }

        // 4️⃣ Actualizar en SAP los que tienen error
        for (const payment of paymentsWithError) {

            await sapService.updatePaymentStatus(payment.DocEntry, {
                U_BPD_status: "ERROR",
                U_BPD_OrderNumber: "ERR-0",
                U_BPD_message: payment.message
            });
        }

        await sapService.logout();

        res.json({
            success: true,
            total: mapped.length,
            withError: paymentsWithError.length,
            valid: validPayments.length,
            data: validPayments
        });

    } catch (error) {

        try { await sapService.logout(); } catch { }

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

function getBankDataError(payment) {

    const missingFields = [];

    if (!payment.BankId) missingFields.push("Banco");
    if (!payment.DflAccount) missingFields.push("Cuenta");
    if (!payment.AccountTypeId) missingFields.push("Tipo de Cuenta");

    if (missingFields.length > 0) {
        return `Los datos bancarios deben estar completos. Faltan: ${missingFields.join(", ")}`;
    }

    return null;
}

app.listen(PORT, () => {
    console.log(`Servidor escuchando en el puerto ${PORT}`);
    // console.log(`Cron Job programado: */30 * * * * *`);
});