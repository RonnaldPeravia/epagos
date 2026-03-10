const sapService = require('../sapService');
const { mapSapPaymentToEPagosDTO } = require('../mappers/paymentMapper');
const { mapToLinkBeneficiaryPayload } = require('../mappers/linkBeneficiaryMapper');
const { findGlobalBeneficiary, createBeneficiary } = require('../epagosService');
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
    const status = error.response?.status;
    const rawData = error.response?.data;

    // Buscar en errordetails el código específico de SAP
    const errorDetails = rawData?.error?.innererror?.errordetails;
    if (errorDetails) {
        const details = Array.isArray(errorDetails) ? errorDetails : [errorDetails];
        const alreadyExists = details.some(d => d.code === 'ZCMG_RI');
        if (alreadyExists) return true;
    }

    // Fallbacks genéricos
    const message = rawData?.error?.message?.value || error.message || '';
    return (
        status === 409 ||
        message.toLowerCase().includes('ya existe este tipo de relación') ||
        message.toLowerCase().includes('already linked') ||
        message.toLowerCase().includes('already exists')
    );
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

                // Cachear también null para no repetir llamadas sin resultado
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
                beneficiaryId: beneficiaryId || null
            });
        }


        // =============================
        // STEP 7 LINK BENEFICIARY & UPDATE BP SYNC STATUS
        // =============================

        logStep("STEP 7", "Linking beneficiaries and updating U_BPD_Synced");

        const syncedCardCodes = new Set();

        for (const result of beneficiaryResults) {

            const { payment, DocEntry, beneficiaryId } = result;
            const cardCode = payment.CardCode;

            // — Skip si ya fue procesado en esta misma ejecución
            if (syncedCardCodes.has(cardCode)) {
                logStep("STEP 7 SKIP", "CardCode already processed in this run", {
                    DocEntry,
                    cardCode
                });
                continue;
            }

            // — Skip si SAP ya lo tiene como sincronizado
            const alreadySynced = payment.BusinessPartner?.U_BPD_Synced === 'Y';

            if (alreadySynced) {
                logStep("STEP 7 SKIP", "BP already synced in SAP (U_BPD_Synced = Y)", {
                    DocEntry,
                    cardCode
                });
                syncedCardCodes.add(cardCode);
                continue;
            }

            // — Sin beneficiario global → marcar como N
            if (!beneficiaryId) {
                logStep("STEP 7", "No global beneficiary found, marking BP as N", {
                    DocEntry,
                    cardCode
                });

                await sapService.updateBPSyncStatus(cardCode, 'N');
                syncedCardCodes.add(cardCode);

                logStep("STEP 7 RESULT", "U_BPD_Synced updated to N", { cardCode });
                continue;
            }

            // — Beneficiario encontrado → intentar vinculación con createBeneficiary
            try {

                const linkPayload = mapToLinkBeneficiaryPayload(payment, beneficiaryId);

                logStep("STEP 7 LINK", "Sending link beneficiary request", {
                    DocEntry,
                    cardCode,
                    beneficiaryId
                });

                logStep("STEP 7 LINK PAYLOAD", "Payload being sent to createBeneficiary", {
                    DocEntry,
                    cardCode,
                    payload: mapToLinkBeneficiaryPayload(payment, beneficiaryId)
                });

                await createBeneficiary(linkPayload);

                logStep("STEP 7 LINK RESULT", "Beneficiary linked successfully", {
                    DocEntry,
                    cardCode
                });

            } catch (linkError) {

                const alreadyLinked = isAlreadyLinkedError(linkError);

                if (!alreadyLinked) {
                    logStep("STEP 7 LINK ERROR", "Failed to link beneficiary, skipping BP sync update", {
                        DocEntry,
                        cardCode,
                        error: linkError.message
                    });
                    continue; // Error real → no actualizar Synced
                }

                logStep("STEP 7 LINK ALREADY", "Beneficiary was already linked", {
                    DocEntry,
                    cardCode
                });
            }

            // — Llegar aquí = vinculado OK o ya estaba vinculado → actualizar Y
            await sapService.updateBPSyncStatus(cardCode, 'Y');
            syncedCardCodes.add(cardCode);

            logStep("STEP 7 RESULT", "U_BPD_Synced updated to Y", { cardCode });
        }

        logStep("STEP 7 SUMMARY", "BP sync step complete", {
            totalProcessed: syncedCardCodes.size
        });


        // =============================
        // STEP 8 LOGOUT SAP
        // =============================

        logStep("STEP 8", "Logging out from SAP");
        await sapService.logout();
        logStep("FLOW END", "Vendor Payments Flow Completed");


        return {
            total: mapped.length,
            valid: validPayments.length,
            errors: paymentsWithError.length,
            beneficiaries: beneficiaryResults.map(r => ({
                DocEntry: r.DocEntry,
                beneficiaryId: r.beneficiaryId
            }))
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