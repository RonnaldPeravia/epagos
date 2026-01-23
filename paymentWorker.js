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
                    console.log(`   El proveedor ${bp.CardCode} no está sincronizado. Iniciando validación...`);

                    // --- LÓGICA DE VERIFICACIÓN Y CONSTRUCCIÓN DE PAYLOAD INTELIGENTE ---

                    const companyId = process.env.BUSINESS_PARTNER_1_ID;

                    const beneficiaryInfo = {
                        identityType: (bp.FederalTaxID.length === 11) ? "DOCE" : "DORN",
                        identityNumber: bp.FederalTaxID.replace(/[^0-9]/g, ''),
                        name: bp.CardName.substring(0, 40),
                        bankId: bankCodeBPD,
                        accountType: (bp.AccountTypeControlKey === 'CA') ? '26' : '20',
                        accountNumber: bp.AccountNo.replace(/[^0-9]/g, ''),
                        methodId: bankCodeBPD === '10101070' ? 'D' : 'A'
                    };

                    // Paso 1: Verificamos si existe globalmente para obtener su ID
                    console.log("      Buscando beneficiario globalmente...");
                    const beneficiaryId = await epagosService.findGlobalBeneficiary(beneficiaryInfo.identityType, beneficiaryInfo.identityNumber);

                    // Paso 2: Construimos el payload correcto
                    const payload = {
                        "RelationshipTypeId": "ZBUBA6",
                        "ZBUBA6Data": {
                            "PaymentOptions": [{
                                // Nombres en PascalCase como los espera la API
                                "BankAccount": { "BankId": beneficiaryInfo.bankId, "AccountTypeId": beneficiaryInfo.accountType, "BankAccountNr": beneficiaryInfo.accountNumber },
                                "MethodId": beneficiaryInfo.methodId,
                                "CurrencyId": "DOP"
                            }]
                        }
                    };

                    if (beneficiaryId) {
                        console.log(`      Beneficiario encontrado globalmente con ID: ${beneficiaryId}. Se procederá a VINCULAR.`);
                        // Si encontramos un ID, preparamos un payload de VINCULACIÓN
                        payload.BusinessPartner2Id = beneficiaryId;
                    } else {
                        payload.BusinessPartner2 = {
                            // Nombres en PascalCase como los espera la API
                            "IdentityTypeId": beneficiaryInfo.identityType,
                            "IdentityNr": beneficiaryInfo.identityNumber,
                            "BusinessPartnerTypeId": "1",
                            "Name1": beneficiaryInfo.name
                        };
                    }

                    // Paso 3: Intentamos la creación/vinculación asíncrona con el payload correcto
                    try {
                        await epagosService.createBeneficiary(payload); // Pasamos el payload ya construido
                    } catch (error) {
                        // La lógica para manejar la respuesta vacía o el error de duplicado (como doble confirmación) se mantiene
                        if (error.message && error.message.includes("Respuesta vacía del servidor")) {
                            console.log("      INFO: Se inició la operación asíncrona. Verificando...");
                        } else if (error.message && error.message.includes("Identificación duplicada")) {
                            console.log("      INFO: El POST falló por duplicado, confirmando que el beneficiario existe.");
                        } else {
                            throw error; // Si es un error diferente, lo lanzamos
                        }
                    }

                    // Paso 4: Sondeo de confirmación (esta lógica no cambia)
                    let isVerified = false;
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

                    if (isVerified) {
                        await sapService.updateBPSyncStatus(bp.CardCode, 'Y');
                        console.log(`   ✅ Proveedor ${bp.CardCode} sincronizado y verificado.`);
                    } else {
                        throw new Error("No se pudo verificar la existencia de la relación en ePagos.");
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
                            // Nombres en PascalCase
                            "IdentityTypeId": (bp.FederalTaxID.length === 11) ? "DOCE" : "DORN",
                            "IdentityNr": bp.FederalTaxID.replace(/[^0-9]/g, '')
                        },
                        // Nombres en PascalCase
                        "CurrencyId": currency,
                        "NetAmount": payment.TransferSum.toFixed(2),
                        "Reference": `SAP-${payment.DocNum}`,
                        "Memo": (payment.Remarks || `Pago DocNum ${payment.DocNum}`).substring(0, 49),
                        "PaymentMethodId": bankCodeBPD === '10101070' ? 'D' : 'A',
                        "BankAccountFromKey": "0001",
                        "BankAccountToKey": "0001",
                        "DocumentClassId": documentClassId,
                        "NCF": ncf,
                        "DocumentDate": currentDateISO,
                        "PaymentDate": currentDateISO
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