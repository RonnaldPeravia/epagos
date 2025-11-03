const axios = require('axios');
const https = require('https');
const fs = require('fs');
const { XMLParser } = require('fast-xml-parser');
require('dotenv').config();

// 1. Configurar el Agente HTTPS para usar el certificado PFX
// Esto es crucial para la autenticación de cliente SSL/TLS
const httpsAgent = new https.Agent({
    pfx: fs.readFileSync(process.env.PFX_CERT_PATH),
    passphrase: process.env.PFX_CERT_PASSPHRASE,
    // En producción, es recomendable no deshabilitar la autorización de certificados
    // rejectUnauthorized: false 
});

// 2. Crear una instancia de Axios pre-configurada
const apiClient = axios.create({
    baseURL: process.env.EPAGOS_QA_URL,
    httpsAgent,
    auth: {
        username: process.env.EPAGOS_USERNAME,
        password: process.env.EPAGOS_PASSWORD,
    },
    headers: {
        'Accept': 'application/xml' // La mayoría de las respuestas son XML
    }
});

// Parser para las respuestas XML
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });

/**
 * Obtiene el token CSRF y la cookie de sesión necesarios para las operaciones POST.
 */
async function getCsrfToken() {
    try {
        const response = await apiClient.get('/', {
            headers: { 'x-csrf-token': 'Fetch' }
        });

        const cookie = response.headers['set-cookie'].join('; ');
        const csrfToken = response.headers['x-csrf-token'];

        if (!cookie || !csrfToken) {
            throw new Error('No se pudo obtener el Token CSRF o la Cookie de sesión.');
        }

        return { csrfToken, cookie };
    } catch (error) {
        console.error("Error al obtener token CSRF:", error.response?.data || error.message);
        throw new Error("Fallo en la obtención del token CSRF.");
    }
}

/**
 * Paso 1 del flujo de beneficiarios: Busca un beneficiario en el sistema global de ePagos.
 */
async function findGlobalBeneficiary(identityType, identityNumber) {
    try {
        const url = `/FindBusinessPartnerByIdentity?IdentityTypeId='${identityType}'&IdentityNr='${identityNumber}'`;
        const response = await apiClient.get(url);
        const parsed = xmlParser.parse(response.data);

        // Si existe, devuelve el ID. El ID está en entry -> content -> m:properties -> d:Id
        return parsed.entry?.content['m:properties']['d:Id'] || null;
    } catch (error) {
        // Un error 404 es esperado si el beneficiario no existe.
        if (error.response && error.response.status === 404) {
            console.log('Beneficiario no encontrado en el sistema global, se procederá a crearlo.');
            return null;
        }
        console.error("Error en la búsqueda global de beneficiario:", error.response?.data);
        throw new Error("Error consultando beneficiario global.");
    }
}

/**
 * Paso 3 del flujo: Crea la relación entre la empresa y el beneficiario.
 */
async function addBeneficiaryToCompany(beneficiaryPayload) {
    try {
        const { csrfToken, cookie } = await getCsrfToken();
        const response = await apiClient.post('/Relationships/', beneficiaryPayload, {
            headers: {
                'x-csrf-token': csrfToken,
                'Cookie': cookie,
                'Accept-Language': 'ES',
                'Content-Type': 'application/json'
            }
        });
        return xmlParser.parse(response.data);
    } catch (error) {
        console.error("Error al añadir beneficiario a la empresa:", error.response?.data);
        throw new Error("Fallo al crear la relación del beneficiario.");
    }
}

/**
 * Orquesta el flujo completo para crear un beneficiario.
 */
async function createBeneficiary(beneficiaryInfo) {
    // Busca si el beneficiario ya existe en ePagos
    const beneficiaryId = await findGlobalBeneficiary(beneficiaryInfo.identityType, beneficiaryInfo.identityNumber);

    // Construye el payload para la creación según la guía (página 10)
    const payload = {
        "RelationshipTypeId": "ZBUBA6",
        "BusinessPartner2": {
            "IdentityTypeId": beneficiaryInfo.identityType,
            "IdentityNr": beneficiaryInfo.identityNumber,
            "BusinessPartnerTypeId": "1", // 1 para Persona
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
                "MethodId": beneficiaryInfo.methodId, // D=Transferencia BPD, A=ACH
                "CurrencyId": "DOP"
            }]
        }
    };

    // Si el beneficiario ya existe, adjuntamos su ID para solo crear la relación
    if (beneficiaryId) {
        payload.BusinessPartner2Id = beneficiaryId;
        // La guía sugiere que si ya existe, se puede omitir la información del Partner2.
        // Esto puede requerir pruebas con el ambiente de QA.
        delete payload.BusinessPartner2;
    }

    return addBeneficiaryToCompany(payload);
}

/**
 * Envía una orden de pago.
 */
async function createPaymentOrder(paymentPayload) {
    try {
        const { csrfToken, cookie } = await getCsrfToken();
        const response = await apiClient.post('/Orders/', paymentPayload, {
            headers: {
                'x-csrf-token': csrfToken,
                'Cookie': cookie,
                'Accept-Language': 'ES',
                'Content-Type': 'application/json'
            }
        });
        return xmlParser.parse(response.data);
    } catch (error) {
        console.error("Error al crear la orden de pago:", error.response?.data);
        const parsedError = xmlParser.parse(error.response.data);
        throw new Error(parsedError.error?.message || "Fallo al crear la orden de pago.");
    }
}

module.exports = {
    createBeneficiary,
    createPaymentOrder
};