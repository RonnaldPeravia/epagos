const { buildZbuba6Base } = require('./zbuba6Base');

function mapToCreateBeneficiaryPayload(payment) {
    return buildZbuba6Base(payment);
}

module.exports = {
    mapToCreateBeneficiaryPayload
};
