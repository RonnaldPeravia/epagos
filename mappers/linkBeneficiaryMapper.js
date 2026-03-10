const { buildZbuba6Base } = require('./zbuba6Base');

/**
 * Mapea pago normalizado al payload de vinculación de beneficiario
 */
function mapToLinkBeneficiaryPayload(payment, beneficiaryId) {
    if (!beneficiaryId) {
        throw new Error('BusinessPartner2Id es requerido para vincular beneficiario');
    }

    const payload = buildZbuba6Base(payment);

    payload.BusinessPartner2Id = String(beneficiaryId); // ← forzar string

    return payload;
}

module.exports = {
    mapToLinkBeneficiaryPayload
};
