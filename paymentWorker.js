const sapService = require('./sapService');
const epagosService = require('./epagosService');

// Mapa de conversión de códigos de banco (Ejemplo)
// Clave: Código en SAP -> Valor: Código en BPD
// Ajustar según la tabla de códigos del PDF (Pág 12)
const BANK_CODES_MAP = {
    'BPD': '10101070',    // Banco Popular
    'BHD': '10101230',    // Banco BHD
    'RESERVAS': '10101010', // Banreservas
    // ... agregar los demás necesarios
};

// Función auxiliar para formatear fechas a ISO sin milisegundos
const getCurrentISODate = () => new Date().toISOString().split('.')[0] + 'Z';

/**
 * Función principal de procesamiento
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

                // Validaciones previas de datos maestros mínimos
                if (!bp.LicTradNum || !bp.BankCode || !bp.AccountNo) {
                    throw new Error("Datos maestros incompletos (Falta RNC, Banco o Cuenta).");
                }

                // 3.2 Verificar/Crear Beneficiario
                if (bp.U_BPD_Synced !== 'Y') {
                    console.log(`   El proveedor ${bp.CardCode} no está sincronizado. Iniciando validación...`);
                    
                    // Determinar tipo documento (Mapeo simple, mejorar según lógica real de SAP)
                    // Asumimos: Si len=9 es RNC (1), si len=11 es Cedula (2). O usar UDF U_TipoIdentificacion
                    let idType = 'RNC'; // Por defecto
                    const cleanId = bp.LicTradNum.replace(/[^0-9]/g, ''); // Solo números
                    
                    if (bp.U_TipoIdentificacion == '2' || cleanId.length === 11) idType = 'DOCE'; // Cédula
                    else if (bp.U_TipoIdentificacion == '3') idType = 'DOPS'; // Pasaporte
                    else idType = 'DORN'; // RNC

                    // Llamada al servicio de beneficiarios
                    const benefResult = await epagosService.createBeneficiary({
                        identityType: idType,
                        identityNumber: cleanId,
                        name: bp.CardName.substring(0, 40) // El banco limita a 40 chars a veces
                    });

                    // Si no hubo error, marcamos como sincronizado en SAP
                    await sapService.updateBPSyncStatus(bp.CardCode, 'Y');
                    console.log(`   Proveedor sincronizado correctamente.`);
                }

                // 3.3 Preparar Payload para la Orden de Pago
                const bankCodeBPD = BANK_CODES_MAP[bp.BankCode] || '0000'; // Fallback si no existe mapeo
                
                // Limpieza de datos
                const cleanAccount = bp.AccountNo.replace(/[^0-9]/g, '');
                const currency = payment.DocCurrency === 'RD$' ? 'DOP' : payment.DocCurrency;
                
                // Estructura según PDF Pág 13 y 22
                const paymentPayload = {
                    "OrderItems": [
                        {
                            "Payee": {
                                "IdentityTypeId": (bp.U_TipoIdentificacion == '2' || bp.LicTradNum.length === 11) ? "DOCE" : "DORN",
                                "IdentityNr": bp.LicTradNum.replace(/[^0-9]/g, ''),
                                "Name1": bp.CardName.substring(0, 49)
                            },
                            "CurrencyId": currency,
                            "NetAmount": payment.TransferSum.toFixed(2),
                            "BankAccountToKey": bankCodeBPD, 
                            "BankAccountNr": cleanAccount,
                            "Reference": (payment.TransferReference || `Pago SAP ${payment.DocNum}`).substring(0, 18),
                            "Memo": (payment.Comments || '').substring(0, 49),
                            // PaymentMethodId: 'D' (Transferencia BPD), 'L' (LBTR), 'A' (ACH)
                            // Lógica simple: Si banco es BPD (10101070) es 'D', sino es interbancario (ACH/LBTR)
                            "PaymentMethodId": bankCodeBPD === '10101070' ? 'D' : 'A' 
                        }
                    ]
                };

                // 3.4 Enviar Orden de Pago
                console.log('   Enviando orden al banco...');
                const orderResult = await epagosService.createPaymentOrder(paymentPayload);
                
                // Extraer número de orden del XML parseado
                // Nota: Ajustar ruta según la respuesta real exacta del parser
                const orderNr = orderResult.entry?.content?.['m:properties']?.['d:OrderNr'];

                if (!orderNr) {
                    throw new Error("El banco no devolvió un número de Orden (OrderNr).");
                }

                // 3.5 Actualizar SAP (ÉXITO)
                await sapService.updatePaymentStatus(payment.DocEntry, {
                    "U_BPD_Status": "PROCESADO",
                    "U_BPD_TrackID": orderNr,
                    "U_BPD_ErrDesc": "",
                    "U_BPD_SyncDate": getCurrentISODate()
                });
                
                console.log(`   ? ÉXITO. Orden Generada: ${orderNr}`);

            } catch (innerError) {
                // 3.6 Manejo de Errores Individual (Para no detener el bucle)
                console.error(`   ? ERROR en Pago ${payment.DocEntry}:`, innerError.message);

                // Generar ID de error para sacar del pool de pendientes
                const errorId = `ERR-${Date.now().toString().substring(6)}`;
                
                await sapService.updatePaymentStatus(payment.DocEntry, {
                    "U_BPD_Status": "ERROR",
                    "U_BPD_TrackID": errorId, 
                    "U_BPD_ErrDesc": innerError.message.substring(0, 250), // Limite SAP campo texto
                    "U_BPD_SyncDate": getCurrentISODate()
                });
            }
        }

    } catch (error) {
        console.error('Error Crítico en el Worker:', error);
    } finally {
        // 4. Logout SAP
        await sapService.logout();
        console.log('--- Ciclo Finalizado ---\n');
    }
}

module.exports = { processPendingPayments };