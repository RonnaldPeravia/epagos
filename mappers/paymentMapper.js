function mapSapPaymentToEPagosDTO(payment) {
    const bp = payment.BusinessPartner || {};
    const bankAccount = bp.BPBankAccounts?.[0] || {};

    const licTradNum = bp.FederalTaxID || '';
    const isCompany = licTradNum.length === 11;

    const bankCode = bankAccount.BankCode || '';
    const bankCtlKey = bankAccount.ControlKey || '';

    const bankMap = {
        '101010708': { id: '10101070', name: 'Banco Popular', method: 'D' },
        '101012308': { id: '10101230', name: 'Banco BHD', method: 'A' },
        '101010106': { id: '10101010', name: 'Banco de Reservas', method: 'A' },
        '101013404': { id: '10101340', name: 'Banco Santa Cruz', method: 'A' },
        '101010601': { id: '10101060', name: 'Citibank', method: 'A' },
        '101010300': { id: '10101030', name: 'Scotiabank', method: 'A' },
        '479409009': { id: '47940900', name: 'Asoc. Popular', method: 'A' },
        '101013909': { id: '10101390', name: 'Banco López de Haro', method: 'A' },
        '101013608': { id: '10101360', name: 'Banco BDI', method: 'A' },
        '444059002': { id: '44405900', name: 'Banco Promerica', method: 'A' },
        '101013802': { id: '10101380', name: 'Banco Vimenca', method: 'A' },
        '101013501': { id: '10101350', name: 'Banco Caribe', method: 'A' },
        '489912007': { id: '48991200', name: 'Asoc. Cibao', method: 'A' },
        '111023280': { id: '11102328', name: 'Banesco', method: 'A' },
        '101013006': { id: '10101300', name: 'Banco Ademi', method: 'A' },
        '102310342': { id: '10231034', name: 'Asoc. La Nacional', method: 'A' },
        '111212143': { id: '11121214', name: 'Banco Multiple Lafise', method: 'A' },
        '101727143': { id: '10172714', name: 'Banco Empire', method: 'A' },
        '111010125': { id: '11101012', name: 'Banco Atlántico', method: 'A' },
        '302324235': { id: '30232423', name: 'Banco Unión', method: 'A' },
        '101712284': { id: '10171228', name: 'Banco de las Americas', method: 'A' }
    };

    const bank = bankMap[bankCode] || {};

    return {
        TipoDocumento: isCompany ? 'DOCE' : 'DORN',
        LicTradNum: licTradNum,
        BusinessPartnerTypeId: isCompany ? '1' : '2',
        CardCode: payment.CardCode,
        CardName: bp.CardName || '',
        BankId: bank.id || '',
        NombreBancoEPagos: bank.name || '',
        AccountTypeId:
            bankCtlKey === 'CC' ? '20' :
                bankCtlKey === 'CA' ? '26' : '',
        DflAccount: bankAccount.AccountNo || '',
        MethodId: bank.method || '',
        DocNum: payment.DocNum,
        DocDate: payment.DocDate,
        Monto: payment.TransferSum
    };
}

module.exports = {
    mapSapPaymentToEPagosDTO
};
