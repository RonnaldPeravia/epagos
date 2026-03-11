const sapService = require('../sapService');
const { mapSapPaymentToEPagosDTO } = require('../mappers/paymentMapper');
const { mapToLinkBeneficiaryPayload } = require('../mappers/linkBeneficiaryMapper');
const { mapToCreateBeneficiaryPayload } = require('../mappers/createBeneficiaryMapper');
const { mapNormalizedPaymentToOrderPayload } = require('../mappers/paymentOrderMapper');
const { findGlobalBeneficiary, createBeneficiary, createPaymentOrder } = require('../epagosService');
const { logStep } = require('../utils/logger');

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

function isAlreadyLinkedError(error) {
    const rawData = error.response?.data;
    const errorDetails = rawData?.error?.innererror?.errordetails;
    if (errorDetails) {
        const details = Array.isArray(errorDetails) ? errorDetails : [errorDetails];
        if (details.some(d => d.code === 'ZCMG_RI')) return true;
    }
    const message = rawData?.error?.message?.value || error.message || '';
    return (
        error.response?.status === 409 ||
        message.toLowerCase().includes('ya existe este tipo de relación') ||
        message.toLowerCase().includes('already linked') ||
        message.toLowerCase().includes('already exists')
    );
}

function isDuplicateIdentityError(error) {
    const rawData = error.response?.data;
    const errorDetails = rawData?.error?.innererror?.errordetails;
    if (errorDetails) {
        const details = Array.isArray(errorDetails) ? errorDetails : [errorDetails];
        if (details.some(d => d.code === 'ZUI5-074')) return true;
    }
    const message = rawData?.error?.message?.value || error.message || '';
    return message.toLowerCase().includes('identificación duplicada');
}

async function runVendorPaymentsTestFlow({ filter, top, skip }) {

    const beneficiaryCache = {};

    try {

        logStep("FLOW START", "Starting Vendor Payments Test Flow");

        // =============================
        // STEP 1 LOGIN SAP
        // =============================

        logStep("STEP 1", "Logging into SAP");
        await sapService.login();
        logStep("STEP 1 RESULT", "SAP login successful");


        // =============================
        // STEP 2 FETCH PAYMENTS
        // =============================

        logStep("STEP 2", "Fetching Vendor Payments from SAP", { filter, top, skip });

        const payments = await sapService.listVendorPaymentsWithBP({
            filter,
            top: Number(top),
            skip: Number(skip)
        });

        logStep("STEP 2 RESULT", "SAP Payments received", { count: payments.length });


        // =============================
        // STEP 3 MAP PAYMENTS
        // =============================

        logStep("STEP 3", "Mapping SAP payments to ePagos DTO");

        const mapped = payments.map(mapSapPaymentToEPagosDTO);

        for (const payment of mapped) {
            logStep("MAPPED PAYMENT", `Payment ${payment.DocEntry} mapped`, {
                DocEntry: payment.DocEntry,
                TipoDocumento: payment.TipoDocumento,
                LicTradNum: payment.LicTradNum,
                BankId: payment.BankId,
                Account: payment.DflAccount,
                Amount: payment.Monto
            });
        }


        // =============================
        // STEP 4 VALIDATE BANK DATA
        // =============================

        logStep("STEP 4", "Validating bank data");

        const validPayments = [];
        const paymentsWithError = [];

        for (const payment of mapped) {
            const errorMessage = getBankDataError(payment);
            if (errorMessage) {
                logStep("VALIDATION ERROR", "Payment failed validation", {
                    DocEntry: payment.DocEntry,
                    errorMessage
                });
                paymentsWithError.push({ DocEntry: payment.DocEntry, message: errorMessage });
            } else {
                logStep("VALIDATION OK", "Payment passed validation", { DocEntry: payment.DocEntry });
                validPayments.push(payment);
            }
        }

        logStep("STEP 4 RESULT", "Validation summary", {
            total: mapped.length,
            valid: validPayments.length,
            errors: paymentsWithError.length
        });


        // =============================
        // STEP 5 UPDATE SAP ERRORS
        // =============================

        for (const payment of paymentsWithError) {
            logStep("STEP 5", "Updating SAP payment with ERROR status", payment);
            await sapService.updatePaymentStatus(payment.DocEntry, {
                U_BPD_status: "ERROR",
                U_BPD_OrderNumber: "ERR-0",
                U_BPD_message: payment.message
            });
            logStep("STEP 5 RESULT", "SAP payment updated", { DocEntry: payment.DocEntry });
        }


        // =============================
        // STEP 6 FIND BENEFICIARIES
        // =============================

        const beneficiaryResults = [];

        for (const payment of validPayments) {

            // — Skip si ya está sincronizado
            const alreadySynced = payment.U_BPD_Synced === 'Y';

            if (alreadySynced) {
                logStep("STEP 6 SKIP", "BP already synced, skipping global beneficiary lookup", {
                    DocEntry: payment.DocEntry,
                    cardCode: payment.CardCode
                });
                beneficiaryResults.push({
                    payment,
                    DocEntry: payment.DocEntry,
                    beneficiaryId: null,
                    synced: true  // ← marcar para STEP 7 y STEP 8
                });
                continue;
            }

            const cacheKey = `${payment.TipoDocumento}-${payment.LicTradNum}`;
            let beneficiaryId = beneficiaryCache[cacheKey];

            if (beneficiaryId === undefined) {
                logStep("STEP 6", "Finding global beneficiary", {
                    DocEntry: payment.DocEntry,
                    TipoDocumento: payment.TipoDocumento,
                    LicTradNum: payment.LicTradNum
                });

                beneficiaryId = await findGlobalBeneficiary(
                    payment.TipoDocumento,
                    payment.LicTradNum
                );

                beneficiaryCache[cacheKey] = beneficiaryId ? String(beneficiaryId) : null;
            } else {
                logStep("STEP 6 CACHE", "Beneficiary found in cache", {
                    DocEntry: payment.DocEntry,
                    cacheKey
                });
            }

            logStep("STEP 6 RESULT", "Beneficiary lookup result", {
                DocEntry: payment.DocEntry,
                beneficiaryId: beneficiaryId || null
            });

            beneficiaryResults.push({
                payment,
                DocEntry: payment.DocEntry,
                beneficiaryId: beneficiaryId ? String(beneficiaryId) : null,
                synced: false
            });
        }


        // =============================
        // STEP 7 CREATE OR LINK BENEFICIARY & UPDATE BP SYNC STATUS
        // =============================

        logStep("STEP 7", "Creating/linking beneficiaries and updating U_BPD_Synced");

        const syncedCardCodes = new Set();

        for (const result of beneficiaryResults) {

            const { payment, DocEntry, beneficiaryId } = result;
            const cardCode = payment.CardCode;

            // — Skip si ya fue procesado en esta ejecución
            if (syncedCardCodes.has(cardCode)) {
                logStep("STEP 7 SKIP", "CardCode already processed in this run", { DocEntry, cardCode });
                continue;
            }

            // — Skip si ya estaba sincronizado desde STEP 6
            if (result.synced) {
                logStep("STEP 7 SKIP", "BP already synced in SAP (U_BPD_Synced = Y)", { DocEntry, cardCode });
                syncedCardCodes.add(cardCode);
                continue;
            }

            // =====================
            // CASO A: No existe globalmente → CREAR
            // =====================
            if (!beneficiaryId) {

                logStep("STEP 7 CREATE", "Beneficiary not found globally, attempting creation", {
                    DocEntry,
                    cardCode
                });

                try {
                    const createPayload = mapToCreateBeneficiaryPayload(payment);
                    await createBeneficiary(createPayload);
                    logStep("STEP 7 CREATE RESULT", "Beneficiary created successfully", { DocEntry, cardCode });
                } catch (createError) {
                    const isDuplicate = isDuplicateIdentityError(createError);
                    if (!isDuplicate) {
                        logStep("STEP 7 CREATE ERROR", "Failed to create beneficiary, skipping", {
                            DocEntry,
                            cardCode,
                            error: createError.message
                        });
                        continue;
                    }
                    logStep("STEP 7 CREATE DUPLICATE", "Beneficiary already exists (ZUI5-074)", { DocEntry, cardCode });
                }

                await sapService.updateBPSyncStatus(cardCode, 'Y');
                syncedCardCodes.add(cardCode);
                logStep("STEP 7 RESULT", "U_BPD_Synced updated to Y after create", { cardCode });
                continue;
            }

            // =====================
            // CASO B: Existe globalmente → VINCULAR
            // =====================
            try {
                const linkPayload = mapToLinkBeneficiaryPayload(payment, beneficiaryId);
                logStep("STEP 7 LINK", "Beneficiary found globally, sending link request", {
                    DocEntry,
                    cardCode,
                    beneficiaryId
                });
                await createBeneficiary(linkPayload);
                logStep("STEP 7 LINK RESULT", "Beneficiary linked successfully", { DocEntry, cardCode });
            } catch (linkError) {
                const alreadyLinked = isAlreadyLinkedError(linkError);
                if (!alreadyLinked) {
                    logStep("STEP 7 LINK ERROR", "Failed to link beneficiary, skipping", {
                        DocEntry,
                        cardCode,
                        error: linkError.message
                    });
                    continue;
                }
                logStep("STEP 7 LINK ALREADY", "Beneficiary was already linked (ZCMG_RI)", { DocEntry, cardCode });
            }

            await sapService.updateBPSyncStatus(cardCode, 'Y');
            syncedCardCodes.add(cardCode);
            logStep("STEP 7 RESULT", "U_BPD_Synced updated to Y after link", { cardCode });
        }

        logStep("STEP 7 SUMMARY", "BP sync step complete", { totalProcessed: syncedCardCodes.size });


        // =============================
        // STEP 8 CREATE PAYMENT ORDERS
        // =============================

        logStep("STEP 8", "Creating payment orders for synced payments");

        const orderResults = [];

        for (const result of beneficiaryResults) {

            const { payment, DocEntry } = result;
            const cardCode = payment.CardCode;

            // — Solo procesar si el BP quedó sincronizado (ya estaba o se sincronizó en STEP 7)
            const isSynced = result.synced || syncedCardCodes.has(cardCode);

            if (!isSynced) {
                logStep("STEP 8 SKIP", "Payment skipped, BP not synced", { DocEntry, cardCode });
                orderResults.push({ DocEntry, success: false, reason: "BP not synced" });
                continue;
            }

            logStep("STEP 8", "Creating payment order", { DocEntry, cardCode });

            try {

                const orderPayload = mapNormalizedPaymentToOrderPayload(payment);

                console.log('orderPayload', orderPayload)

                const orderResult = await createPaymentOrder(orderPayload);

                const orderNumber = orderResult?.details?.orderNumber;

                logStep("STEP 8 RESULT", "Payment order created successfully", {
                    DocEntry,
                    cardCode,
                    orderNumber
                });

                // — Actualizar SAP con el resultado
                await sapService.updatePaymentStatus(DocEntry, {
                    U_BPD_OrderNumber: orderNumber || '',
                    U_BPD_message: "Orden de pago creada exitosamente",
                    U_BPD_SyncDate: new Date().toISOString().split('T')[0]
                });

                logStep("STEP 8 SAP UPDATE", "SAP payment updated with order number", {
                    DocEntry,
                    orderNumber
                });

                orderResults.push({ DocEntry, success: true, orderNumber });

            } catch (orderError) {

                logStep("STEP 8 ERROR", "Failed to create payment order", {
                    DocEntry,
                    cardCode,
                    error: orderError.message
                });

                // — Actualizar SAP con el error
                await sapService.updatePaymentStatus(DocEntry, {
                    U_BPD_OrderNumber: "ERR-0",
                    U_BPD_message: orderError.message.substring(0, 254),
                    U_BPD_SyncDate: new Date().toISOString().split('T')[0]
                });

                orderResults.push({ DocEntry, success: false, reason: orderError.message });
            }
        }

        logStep("STEP 8 SUMMARY", "Payment orders step complete", {
            total: orderResults.length,
            success: orderResults.filter(r => r.success).length,
            failed: orderResults.filter(r => !r.success).length
        });


        // =============================
        // STEP 9 LOGOUT SAP
        // =============================

        logStep("STEP 9", "Logging out from SAP");
        await sapService.logout();
        logStep("FLOW END", "Vendor Payments Flow Completed");


        return {
            total: mapped.length,
            valid: validPayments.length,
            errors: paymentsWithError.length,
            beneficiaries: beneficiaryResults.map(r => ({
                DocEntry: r.DocEntry,
                beneficiaryId: r.beneficiaryId
            })),
            orders: orderResults
        };

    } catch (error) {

        logStep("FLOW ERROR", "Unhandled flow error", {
            message: error.message,
            stack: error.stack
        });

        try { await sapService.logout(); } catch { }

        throw error;
    }
}

module.exports = { runVendorPaymentsTestFlow };