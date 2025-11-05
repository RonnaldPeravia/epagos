const axios = require('axios');
const https = require('https');
const fs = require('fs');
const { XMLParser } = require('fast-xml-parser');
require('dotenv').config();

// Configuración del agente HTTPS para usar el certificado PFX
const httpsAgent = new https.Agent({
    pfx: fs.readFileSync(process.env.PFX_CERT_PATH),
    passphrase: process.env.PFX_CERT_PASSPHRASE,
});

// --- CLIENTES API SEPARADOS ---

// Cliente para el servicio ZGW_WSDMZ_SRV (Relaciones, Órdenes, etc.)
const wsdmzClient = axios.create({
    baseURL: process.env.EPAGOS_QA_URL_WSDMZ,
    httpsAgent,
    auth: {
        username: process.env.EPAGOS_USERNAME,
        password: process.env.EPAGOS_PASSWORD,
    },
});

// Cliente para el servicio ZGW_COMMON_SRV (Búsqueda global)
const commonClient = axios.create({
    baseURL: process.env.EPAGOS_QA_URL_COMMON,
    httpsAgent,
    auth: {
        username: process.env.EPAGOS_USERNAME,
        password: process.env.EPAGOS_PASSWORD,
    },
});

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });

// --- FUNCIONES INTERNAS DEL SERVICIO ---

/**
 * Obtiene el token CSRF y la cookie de sesión.
 */
async function getCsrfToken() {
    try {
        const response = await wsdmzClient.get('/', {
            headers: { 'x-csrf-token': 'Fetch' }
        });
        const cookie = response.headers['set-cookie'].join('; ');
        const csrfToken = response.headers['x-csrf-token'];
        if (!cookie || !csrfToken) throw new Error('No se pudo obtener el Token CSRF o la Cookie.');
        return { csrfToken, cookie };
    } catch (error) {
        console.error("Error al obtener token CSRF:", error.response?.data || error.message);
        throw new Error("Fallo en la obtención del token CSRF.");
    }
}

/**
 * Paso 1: Busca un beneficiario en el sistema global de ePagos.
 */
async function findGlobalBeneficiary(identityType, identityNumber) {
    try {
        const url = `/FindBusinessPartnerByIdentity?IdentityTypeId='${identityType}'&IdentityNr='${identityNumber}'`;
        const response = await commonClient.get(url, { headers: { 'Accept': 'application/xml' } });

        if (response.headers['content-type']?.includes('text/html')) {
            throw new Error("La solicitud fue bloqueada por el firewall de seguridad. Verifique que su IP pública esté autorizada.");
        }

        const parsed = xmlParser.parse(response.data);
        return parsed.entry?.content['m:properties']['d:Id'] || null;
    } catch (error) {
        if (error.response?.status === 404) return null;
        if (error.message.includes("firewall de seguridad")) throw error;
        console.error("Error en búsqueda global:", error.response?.data);
        throw new Error("Error consultando beneficiario global.");
    }
}

/**
 * Paso 2: Verifica si ya existe una relación entre la empresa y un beneficiario.
 */
async function checkBeneficiaryRelationship(companyId, beneficiaryId) {
    try {
        const url = `/Relationships(BusinessPartner1Id='${companyId}',BusinessPartner2Id='${beneficiaryId}',RelationshipTypeId='ZBUBA6')`;
        await wsdmzClient.get(url, { headers: { 'Accept': 'application/xml' } });
        return true;
    } catch (error) {
        if (error.response?.status === 404) return false;
        console.error("Error al verificar relación:", error.response?.data);
        throw new Error("Fallo al consultar relación en perfil de empresa.");
    }
}

/**
 * Paso 3: Crea una nueva relación entre la empresa y el beneficiario.
 */
async function addBeneficiaryToCompany(beneficiaryPayload) {
    try {
        const { csrfToken, cookie } = await getCsrfToken();
        const response = await wsdmzClient.post('/Relationships/', beneficiaryPayload, {
            headers: {
                'x-csrf-token': csrfToken,
                'Cookie': cookie,
                'Accept-Language': 'ES',
                'Content-Type': 'application/json'
            }
        });
        return xmlParser.parse(response.data);
    } catch (error) {
        console.error("Error al añadir beneficiario:", error.response?.data);
        throw new Error("Fallo al crear la relación del beneficiario.");
    }
}

// --- FUNCIONES EXPORTADAS ---

module.exports = {
    /**
     * Orquesta el flujo completo para crear o vincular un beneficiario.
     */
    createBeneficiary: async (beneficiaryInfo) => {
        const companyId = process.env.BUSINESS_PARTNER_1_ID;
        if (!companyId) throw new Error("BUSINESS_PARTNER_1_ID no está configurado en .env");

        const beneficiaryId = await findGlobalBeneficiary(beneficiaryInfo.identityType, beneficiaryInfo.identityNumber);

        if (beneficiaryId) {
            const relationshipExists = await checkBeneficiaryRelationship(companyId, beneficiaryId);
            if (relationshipExists) {
                console.log("Relación ya existe. No se tomará ninguna acción.");
                return { status: 'exists', message: 'El beneficiario ya está asociado a esta empresa.' };
            }
        }

        console.log("Creando o vinculando nuevo beneficiario...");
        const payload = {
            "RelationshipTypeId": "ZBUBA6",
            "BusinessPartner2": {
                "IdentityTypeId": beneficiaryInfo.identityType,
                "IdentityNr": beneficiaryInfo.identityNumber,
                "BusinessPartnerTypeId": "1",
                "Name1": beneficiaryInfo.name
            },
            "ZBUBA6Data": {
                "PaymentOptions": [{
                    "RelationshipTypeId": "ZBUBA6",
                    "BankAccount": {
                        "BankId": beneficiaryInfo.bankId,
                        "AccountTypeId": beneficiaryInfo.accountType,
                        "BankAccountNr": beneficiaryInfo.accountNumber
                    },
                    "MethodId": beneficiaryInfo.methodId,
                    "CurrencyId": "DOP"
                }]
            }
        };

        if (beneficiaryId) {
            payload.BusinessPartner2Id = beneficiaryId;
            delete payload.BusinessPartner2;
        }

        return addBeneficiaryToCompany(payload);
    },

    /**
     * Envía una orden de pago.
     */
    createPaymentOrder: async (paymentPayload) => {
        try {
            const { csrfToken, cookie } = await getCsrfToken();
            const response = await wsdmzClient.post('/Orders/', paymentPayload, {
                headers: {
                    'x-csrf-token': csrfToken,
                    'Cookie': cookie,
                    'Accept-Language': 'ES',
                    'Content-Type': 'application/json'
                }
            });
            return xmlParser.parse(response.data);
        } catch (error) {
            console.error("Error al crear orden de pago:", error.response?.data);
            const parsedError = xmlParser.parse(error.response.data);
            throw new Error(parsedError.error?.message || "Fallo al crear la orden de pago.");
        }
    }
};