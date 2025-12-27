const sapService = require('./sapService');
const epagosService = require('./epagosService');

// Mantén tu mapa de códigos de banco. ¡Tu lógica de mapeo es correcta!
const BANK_CODES_MAP = {
    '101010708': '10101070', // Banco Popular
    '101012308': '10101230', // Banco BHD
    '101010106': '10101010', // Banreservas
    '101013404': '10101340', // Santa Cruz
};

const getCurrentISODate = () => new Date().toISOString().split('.')[0] + 'Z';

async function processPendingPayments() {
    console.log(`\n--- Iniciando Ciclo de Procesamiento: ${new Date().toLocaleTimeString()} ---`);

    try {
        await sapService.login();
        const payments = await sapService.getPendingPayments();
        if (payments.length === 0) {
            console.log('No hay pagos pendientes para procesar.');
            return;
        }
        console.log(`Se encontraron ${payments.length} pagos pendientes.`);
        console.log('payments: ', payments)

        for (const payment of payments) {
            console.log(`\n>>> Procesando Pago DocEntry: ${payment.DocEntry} (Prov: ${payment.CardCode})`);

            try {
                // --- 1. OBTENCIÓN DE DATOS CON LOGS ---
                console.log("   1. Obteniendo datos del Business Partner desde SAP...");
                const bp = await sapService.getBusinessPartner(payment.CardCode);
                console.log("      Datos de BP recibidos:", JSON.stringify(bp, null, 2));

                // Validación robusta de datos maestros
                if (!bp.FederalTaxID) throw new Error("Datos maestros incompletos: Falta el RNC/Cédula (FederalTaxID).");
                if (!bp.BankCode || !bp.AccountNo) throw new Error("Datos maestros incompletos: Falta el Banco (BankCode) o la Cuenta (AccountNo).");
                if (!bp.AccountTypeControlKey) throw new Error("Datos maestros incompletos: Falta el Tipo de Cuenta (ControlKey: 'CC' o 'CA').");

                // --- 2. SINCRONIZACIÓN DE BENEFICIARIO (CON LÓGICA DE DUPLICADO) ---
                if (bp.U_BPD_Synced !== 'Y') {
                    console.log(`   El proveedor ${bp.CardCode} no está sincronizado. Validando/Creando en ePagos...`);

                    // --- LÓGICA DE VERIFICACIÓN PRIMERO (CLEAN ARCHITECTURE) ---

                    // Construimos la información del beneficiario que necesitamos para verificar
                    const beneficiaryInfo = {
                        identityType: (bp.FederalTaxID.length === 11) ? "DOCE" : "DORN",
                        identityNumber: bp.FederalTaxID.replace(/[^0-9]/g, ''),
                        // ... (el resto de los campos para la creación posterior)
                    };

                    // Paso 1: Verificamos si ya existe ANTES de intentar crear
                    let isVerified = await epagosService.checkBeneficiaryRelationshipExists(
                        process.env.BUSINESS_PARTNER_1_ID,
                        beneficiaryInfo.identityType,
                        beneficiaryInfo.identityNumber
                    );

                    // Paso 2: Si no existe, procedemos a crear y luego a verificar con sondeo
                    if (!isVerified) {
                        console.log("      Beneficiario no encontrado. Intentando POST para crear/vincular...");

                        try {
                            await epagosService.createBeneficiary(beneficiaryInfo);
                        } catch (error) {
                            console.log('createBeneficiary error: ', error)
                            if (error.message && error.message.includes("Identificación duplicada")) {
                                console.log("      INFO: El POST falló por duplicado, confirmando que el beneficiario existe. Se considera sincronizado.");
                                isVerified = true; // Forzamos la verificación a true
                            } else if (error.message && error.message.includes("Respuesta vacía del servidor")) {
                                console.log("      INFO: Se inició la creación asíncrona. Se procederá a verificar...");
                                // Dejamos que el sondeo de abajo haga el trabajo
                            } else {
                                throw error; // Si es un error diferente, lo lanzamos
                            }
                        }

                        // Solo hacemos sondeo si la creación fue asíncrona y no sabemos el estado
                        if (!isVerified) {
                            for (let i = 0; i < 3; i++) {
                                console.log(`      Intento de verificación post-creación #${i + 1}...`);
                                await new Promise(resolve => setTimeout(resolve, 5000));

                                const relationshipExists = await epagosService.checkBeneficiaryRelationshipExists(
                                    process.env.BUSINESS_PARTNER_1_ID,
                                    beneficiaryInfo.identityType,
                                    beneficiaryInfo.identityNumber
                                );
                                if (relationshipExists) {
                                    isVerified = true;
                                    break;
                                }
                            }
                        }
                    } else {
                        console.log("   INFO: El beneficiario ya existía en ePagos. Saltando creación.");
                    }

                    // Paso 3: Actualizar SAP si la verificación fue exitosa
                    if (isVerified) {
                        await sapService.updateBPSyncStatus(bp.CardCode, 'Y');
                        console.log(`   ✅ Proveedor ${bp.CardCode} sincronizado y verificado.`);
                    } else {
                        throw new Error("No se pudo verificar la existencia del beneficiario en ePagos después de varios intentos.");
                    }
                }

                // --- 3. CREACIÓN DE LA ORDEN DE PAGO (CON LOGS) ---
                console.log("   3. Preparando el payload para la Orden de Pago...");

                // Lógica de Negocio para determinar DocumentClassId y NCF
                let documentClassId = "DG"; // Por defecto: Factura sin valor fiscal
                let ncf = ""; // Por defecto: Vacío

                // EJEMPLO de lógica: Si el campo de Referencia en SAP empieza con 'B', asumimos que es un NCF.
                // DEBES AJUSTAR ESTA LÓGICA a cómo tu empresa identifica los pagos con NCF en SAP.
                if (payment.TransferReference && payment.TransferReference.startsWith('B')) {
                    documentClassId = "FA"; // Factura con Valor Fiscal
                    ncf = payment.TransferReference;
                }

                const bankCodeBPD = BANK_CODES_MAP[bp.BankCode];
                const currency = payment.DocCurrency === 'RD$' ? 'DOP' : payment.DocCurrency;

                // OBTENEMOS LA FECHA ACTUAL EN EL FORMATO REQUERIDO (YYYY-MM-DDTHH:mm:ss)
                const currentDateISO = new Date().toISOString().split('.')[0];

                const paymentPayload = {
                    "OrderTypeId": "A",
                    "OrderItems": [{
                        "Payee": {
                            "IdentityTypeId": (bp.FederalTaxID.length === 11) ? "DOCE" : "DORN",
                            "IdentityNr": bp.FederalTaxID.replace(/[^0-9]/g, '')
                        },
                        "CurrencyId": currency,
                        "NetAmount": payment.TransferSum.toFixed(2),
                        "Reference": `SAP-${payment.DocNum}`,
                        "Memo": (payment.Remarks || `Pago DocNum ${payment.DocNum}`).substring(0, 49),
                        "PaymentMethodId": bankCodeBPD === '10101070' ? 'D' : 'A',
                        // Keys de Cuentas: Asumimos '0001' como valor por defecto.
                        "BankAccountFromKey": "0001",
                        "BankAccountToKey": "0001",

                        // Lógica de Tipo de Documento
                        "DocumentClassId": documentClassId,
                        "NCF": ncf,

                        "DocumentDate": `${currentDateISO.split('T')[0]}T00:00:00`,
                        "PaymentDate": `${currentDateISO.split('T')[0]}T00:00:00`
                    }]
                };

                console.log("      Payload de la Orden de Pago a enviar:", JSON.stringify(paymentPayload, null, 2));

                console.log("   4. Enviando orden al banco...");
                const orderResult = await epagosService.createPaymentOrder(paymentPayload);

                // --- MANEJO DE RESPUESTA SÍNCRONA/ASÍNCRONA ---
                const orderNr = orderResult.details?.orderNumber;
                if (!orderNr) throw new Error("La API aceptó el pago pero no devolvió un número de Orden (OrderNr).");

                console.log(`   ✅ ÉXITO. Orden Generada: ${orderNr}`);
                await sapService.updatePaymentStatus(payment.DocEntry, {
                    "U_BPD_status": "PROCESADO",
                    "U_BPD_OrderNumber": orderNr,
                    "U_BPD_message": "Procesado exitosamente via ePagos."
                });

            } catch (innerError) {
                console.error(`   ❌ ERROR en Pago ${payment.DocEntry}:`, innerError.message);

                await sapService.updatePaymentStatus(payment.DocEntry, {
                    "U_BPD_status": "ERROR",
                    "U_BPD_OrderNumber": `ERR-${Date.now().toString().substring(6)}`,
                    "U_BPD_message": innerError.message.substring(0, 254)
                });
            }
        }

    } catch (error) {
        console.error('Error Crítico en el Worker:', error);
    } finally {
        await sapService.logout();
        console.log('--- Ciclo Finalizado ---\n');
    }
}

module.exports = { processPendingPayments };