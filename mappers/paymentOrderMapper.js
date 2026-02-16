/**
 * Mapea un pago normalizado a payload de OrderPayment (ePagos)
 */
function mapNormalizedPaymentToOrderPayload(payment) {
    if (!payment.LicTradNum) {
        throw new Error('LicTradNum es requerido para crear orden de pago');
    }
    if (!payment.Monto) {
        throw new Error('Monto es requerido para crear orden de pago');
    }

    // Nota: estos campos no están en tu objeto normalizado:
    // - Reference (DocNum o TransferReference)
    // - Memo (puede ser Remarks o descripción)
    // - BankAccountFromKey (se define según tu cuenta origen)
    // - DocumentDate / PaymentDate (debes decidir si usar DocDate o la fecha actual)
    // Si no los tienes, usa defaults o completa en la orquestación.

    return {
        OrderTypeId: "A",
        OrderItems: [
            {
                Payee: {
                    IdentityTypeId: payment.TipoDocumento,
                    IdentityNr: payment.LicTradNum
                },
                CurrencyId: "DOP",
                NetAmount: String(payment.Monto),
                Reference: payment.DocNum ? String(payment.DocNum) : "",

                // Si tienes un campo de memo, úsalo aquí.
                Memo: `PAGO DOC ${payment.DocNum || 'N/A'}`,

                PaymentMethodId: payment.MethodId,
                BankAccountFromKey: "0001", // <- debes definirlo según tu cuenta origen

                DocumentClassId: "DG",

                // Si tienes DocDate, úsalo; sino usa hoy.
                DocumentDate: payment.DocDate ? `${payment.DocDate}T00:00:00` : new Date().toISOString(),
                PaymentDate: payment.DocDate ? `${payment.DocDate}T00:00:00` : new Date().toISOString()
            }
        ]
    };
}

module.exports = {
    mapNormalizedPaymentToOrderPayload
};
