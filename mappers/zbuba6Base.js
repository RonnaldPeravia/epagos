function buildZbuba6Base(payment) {
    return {
        RelationshipTypeId: 'ZBUBA6',

        BusinessPartner2: {
            IdentityTypeId: payment.TipoDocumento,
            IdentityNr: payment.LicTradNum,
            BusinessPartnerTypeId: payment.BusinessPartnerTypeId,
            Name1: payment.CardName
        },

        ZBUBA6Data: {
            PaymentOptions: [
                {
                    RelationshipTypeId: 'ZBUBA6',
                    BankAccount: {
                        BankId: payment.BankId,
                        AccountTypeId: payment.AccountTypeId,
                        BankAccountNr: payment.DflAccount
                    },
                    MethodId: payment.MethodId,
                    CurrencyId: 'DOP'
                }
            ],

            DocumentClasses: [
                {
                    RelationshipTypeId: 'ZBUBA6',
                    DocumentClassId: 'DG'
                }
            ]
        }
    };
}

module.exports = {
    buildZbuba6Base
};
