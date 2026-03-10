const sapService = require('../sapService');
const { mapSapPaymentToEPagosDTO } = require('../mappers/paymentMapper');
const { findGlobalBeneficiary } = require('../epagosService');
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

            if (!beneficiaryId) {
                logStep("STEP 6", "Finding global beneficiary", {
                    DocEntry: payment.DocEntry,
                    TipoDocumento: payment.TipoDocumento,
                    LicTradNum: payment.LicTradNum
                });

                beneficiaryId = await findGlobalBeneficiary(
                    payment.TipoDocumento,
                    payment.LicTradNum
                );

                beneficiaryCache[cacheKey] = beneficiaryId;
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
                payment,                          // <-- guardamos el payment completo para el paso siguiente
                DocEntry: payment.DocEntry,
                beneficiaryId: beneficiaryId || null
            });
        }


        // =============================
        // STEP 7 UPDATE BP SYNC STATUS
        // =============================

        logStep("STEP 7", "Updating BusinessPartners U_BPD_Synced field");

        // Evitar actualizar el mismo CardCode más de una vez
        const syncedCardCodes = new Set();

        for (const result of beneficiaryResults) {

            const cardCode = result.payment.CardCode;

            if (!cardCode || syncedCardCodes.has(cardCode)) {
                logStep("STEP 7 SKIP", "BP already updated or CardCode missing", {
                    DocEntry: result.DocEntry,
                    cardCode: cardCode || null
                });
                continue;
            }

            const syncValue = result.beneficiaryId ? 'Y' : 'N';

            logStep("STEP 7", "Updating BP sync status", {
                DocEntry: result.DocEntry,
                cardCode,
                U_BPD_Synced: syncValue
            });

            await sapService.updateBPSyncStatus(cardCode, syncValue);

            syncedCardCodes.add(cardCode);

            logStep("STEP 7 RESULT", "BP sync status updated", {
                cardCode,
                U_BPD_Synced: syncValue
            });
        }

        logStep("STEP 7 SUMMARY", "BP sync update complete", {
            totalUpdated: syncedCardCodes.size
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