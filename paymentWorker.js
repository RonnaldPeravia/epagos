const sapService = require('./sapService');
const epagosService = require('./epagosService');

// Mapa de conversi�n de c�digos de banco (Ejemplo)
// Clave: C�digo en SAP -> Valor: C�digo en BPD
// Ajustar seg�n la tabla de c�digos del PDF (P�g 12)
const BANK_CODES_MAP = {
    '101010708': '10101070', // Banco Popular
    '101012308': '10101230', // Banco BHD
    '101010106': '10101010', // Banreservas
    '101013404': '10101340', // Santa Cruz
};

// Funci�n auxiliar para formatear fechas a ISO sin milisegundos
const getCurrentISODate = () => new Date().toISOString().split('.')[0] + 'Z';

/**
 * Funci�n principal de procesamiento
 */
async function processPendingPayments() {
    console.log(`\n--- Iniciando Ciclo de Procesamiento: ${new Date().toLocaleTimeString()} ---`);

    try {
        // 1. Login en SAP
        await sapService.login();

        // 2. Obtener Pagos Pendientes
        const payments = await sapService.getPendingPayments();

        if (payments.length === 0) {
            console.log('No hay pagos pendientes para procesar.');
            return;
        }

        console.log(`Se encontraron ${payments.length} pagos pendientes.`);

        // 3. Iterar sobre cada pago
        for (const payment of payments) {
            console.log(`>>> Procesando Pago DocEntry: ${payment.DocEntry} (Prov: ${payment.CardCode})`);

            try {
                // 3.1 Obtener detalles del Proveedor (Cuenta Bancaria, RNC, Flag Sync)
                const bp = await sapService.getBusinessPartner(payment.CardCode);

                console.log('bp: ', bp)

                // Validaciones previas de datos maestros m�nimos
                if (!bp.FederalTaxID || !bp.BankCode || !bp.AccountNo) {
                    throw new Error("Datos maestros incompletos (Falta RNC, Banco o Cuenta).");
                }

                // 3.2 Verificar/Crear Beneficiario
                if (bp.U_BPD_Synced !== 'Y') {
                    console.log(`   El proveedor ${bp.CardCode} no está sincronizado. Iniciando validación...`);

                    const bankCodeBPD = BANK_CODES_MAP[bp.BankCode];

                    if (!bankCodeBPD) {
                        throw new Error(`El código de banco '${bp.BankCode}' del proveedor no tiene un mapeo definido en BANK_CODES_MAP.`);
                    }

                    const beneficiaryInfo = {
                        identityType: (bp.FederalTaxID.length === 11) ? "DOCE" : "DORN",
                        identityNumber: bp.FederalTaxID.replace(/[^0-9]/g, ''),
                        name: bp.CardName.substring(0, 40),
                        bankId: bankCodeBPD,
                        accountType: "20", // Asumimos '20' (Corriente) por defecto. Ajustar si es necesario.
                        accountNumber: bp.AccountNo.replace(/[^0-9]/g, ''),
                        methodId: bankCodeBPD === '10101070' ? 'D' : 'A' // 'D' para BPD, 'A' para otros (ACH)
                    };

                    // Paso 1: Intentamos la creación, esperando que pueda fallar con respuesta vacía
                    try {
                        await epagosService.createBeneficiary(beneficiaryInfo);
                    } catch (error) {
                        if (error.message.includes("Contenido: undefined") || error.message.includes("read ECONNRESET")) {
                            console.log("   Se inició la creación asíncrona del beneficiario. Verificando...");
                        } else {
                            // Si es un error real (ej. 401), lanzamos el error para que el pago falle.
                            throw new Error(`Error real al crear beneficiario: ${error.message}`);
                        }
                    }

                    // Paso 2: Sondeo para verificar si realmente se creó
                    let isCreated = false;
                    const maxRetries = 3;
                    const retryDelay = 10000; // 10 segundos

                    for (let i = 0; i < maxRetries; i++) {
                        await new Promise(resolve => setTimeout(resolve, retryDelay)); // Esperar

                        const relationshipExists = await epagosService.checkBeneficiaryRelationshipExists(
                            process.env.BUSINESS_PARTNER_1_ID,
                            beneficiaryInfo.identityType,
                            beneficiaryInfo.identityNumber
                        );

                        if (relationshipExists) {
                            isCreated = true;
                            break;
                        }
                    }

                    if (!isCreated) {
                        throw new Error("No se pudo verificar la creación del beneficiario después de varios intentos.");
                    }

                    // Si la verificación fue exitosa, marcamos como sincronizado en SAP
                    await sapService.updateBPSyncStatus(bp.CardCode, 'Y');
                    console.log(`   Proveedor sincronizado y verificado correctamente.`);

                }

                // 3.3 Preparar Payload para la Orden de Pago
                const bankCodeBPD = BANK_CODES_MAP[bp.BankCode] || '0000'; // Fallback si no existe mapeo

                // Limpieza de datos
                const cleanAccount = bp.AccountNo.replace(/[^0-9]/g, '');
                const currency = payment.DocCurrency === 'RD$' ? 'DOP' : payment.DocCurrency;

                // Estructura seg�n PDF P�g 13 y 22
                const paymentPayload = {
                    "OrderItems": [
                        {
                            "Payee": {
                                "IdentityTypeId": (bp.FederalTaxID.length === 11) ? "DOCE" : "DORN",
                                "IdentityNr": bp.FederalTaxID.replace(/[^0-9]/g, ''),
                                "Name1": bp.CardName.substring(0, 49)
                            },
                            "CurrencyId": currency,
                            "NetAmount": payment.TransferSum.toFixed(2),
                            // "BankAccountToKey": bankCodeBPD,
                            // "BankAccountNr": cleanAccount,
                            "BankAccountToKey": "0001",
                            "BankAccountFromKey": "0001", // Asumiendo que la empresa también usa su primera cuenta
                            "Reference": (payment.TransferReference || `Pago SAP ${payment.DocNum}`).substring(0, 18),
                            "Memo": (payment.Comments || '').substring(0, 49),
                            // PaymentMethodId: 'D' (Transferencia BPD), 'L' (LBTR), 'A' (ACH)
                            // L�gica simple: Si banco es BPD (10101070) es 'D', sino es interbancario (ACH/LBTR)
                            "PaymentMethodId": bankCodeBPD === '10101070' ? 'D' : 'A'
                        }
                    ]
                };

                // 3.4 Enviar Orden de Pago
                console.log('   Enviando orden al banco...');
                const orderResult = await epagosService.createPaymentOrder(paymentPayload);

                // Extraer n�mero de orden del XML parseado
                // Nota: Ajustar ruta seg�n la respuesta real exacta del parser
                const orderNr = orderResult.entry?.content?.['m:properties']?.['d:OrderNr'];

                if (!orderNr) {
                    throw new Error("El banco no devolvi� un n�mero de Orden (OrderNr).");
                }

                // 3.5 Actualizar SAP (�XITO)
                await sapService.updatePaymentStatus(payment.DocEntry, {
                    "U_BPD_status": "PROCESADO",
                    "U_BPD_OrderNumber": orderNr,
                    "U_BPD_message": "",
                    "U_BPD_SyncDate": getCurrentISODate()
                });

                console.log(`   ? �XITO. Orden Generada: ${orderNr}`);

            } catch (innerError) {
                // 3.6 Manejo de Errores Individual (Para no detener el bucle)
                console.error(`   ? ERROR en Pago ${payment.DocEntry}:`, innerError.message);

                // Generar ID de error para sacar del pool de pendientes
                const errorId = `ERR-${Date.now().toString().substring(6)}`;

                await sapService.updatePaymentStatus(payment.DocEntry, {
                    "U_BPD_status": "ERROR",
                    "U_BPD_OrderNumber": errorId,
                    "U_BPD_message": innerError.message.substring(0, 254), // Limite SAP campo texto
                    "U_BPD_SyncDate": getCurrentISODate()
                });
            }
        }

    } catch (error) {
        console.error('Error Cr�tico en el Worker:', error);
    } finally {
        // 4. Logout SAP
        await sapService.logout();
        console.log('--- Ciclo Finalizado ---\n');
    }
}

module.exports = { processPendingPayments };