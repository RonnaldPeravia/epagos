const axios = require('axios');
const https = require('https');
const fs = require('fs');
const { XMLParser } = require('fast-xml-parser');
require('dotenv').config();

const rootCA = fs.readFileSync('./BPD-RCA.txt');
const subordinateCA = fs.readFileSync('./BPD-SCA.txt');

// Configuración del agente HTTPS (sin cambios)
const httpsAgent = new https.Agent({
    pfx: fs.readFileSync(process.env.PFX_CERT_PATH),
    passphrase: process.env.PFX_CERT_PASSPHRASE,
    ca: [rootCA, subordinateCA]
});

// Clientes API (sin cambios)
const wsdmzClient = axios.create({
    baseURL: process.env.EPAGOS_QA_URL_WSDMZ,
    httpsAgent,
    auth: { username: process.env.EPAGOS_USERNAME, password: process.env.EPAGOS_PASSWORD },
});
const commonClient = axios.create({
    baseURL: process.env.EPAGOS_QA_URL_COMMON,
    httpsAgent,
    auth: { username: process.env.EPAGOS_USERNAME, password: process.env.EPAGOS_PASSWORD },
});

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });

// --- FUNCIONES INTERNAS DEL SERVICIO ---

/**
 * Obtiene el token CSRF y la cookie. Sigue siendo la primera llamada.
 */
async function getCsrfToken() {
    try {
        const response = await wsdmzClient.get('/', { headers: { 'x-csrf-token': 'Fetch' } });
        const cookie = response.headers['set-cookie'].join('; ');
        const csrfToken = response.headers['x-csrf-token'];
        if (!cookie || !csrfToken) throw new Error('No se pudo obtener el Token CSRF o la Cookie.');
        return { csrfToken, cookie };
    } catch (error) {
        console.log('error: ', error)
        console.error("Error al obtener token CSRF:", error.response?.data || error.message);
        throw new Error("Fallo en la obtención del token CSRF.");
    }
}

/**
 * CAMBIO: Ahora acepta y usa el token CSRF para la petición GET.
 */
async function findGlobalBeneficiary(identityType, identityNumber, authHeaders) {
    try {
        const url = `/FindBusinessPartnerByIdentity?IdentityTypeId='${identityType}'&IdentityNr='${identityNumber}'`;
        const response = await commonClient.get(url, {
            headers: {
                'Accept': 'application/xml',
                'x-csrf-token': authHeaders.csrfToken, // <-- AÑADIDO
                'Cookie': authHeaders.cookie,          // <-- AÑADIDO
            }
        });
        if (response.headers['content-type']?.includes('text/html')) {
            throw new Error("La solicitud fue bloqueada por el firewall de seguridad (WAF).");
        }
        const parsed = xmlParser.parse(response.data);
        return parsed.entry?.content['m:properties']['d:Id'] || null;
    } catch (error) {
        if (error.response?.status === 404) return null;
        if (error.message.includes("firewall")) throw error;
        console.error("Error en búsqueda global:", error.response?.data);
        throw new Error("Error consultando beneficiario global.");
    }
}

/**
 * CAMBIO: Ahora acepta y usa el token CSRF para la petición GET.
 */
async function checkBeneficiaryRelationship(companyId, beneficiaryId, authHeaders) {
    try {
        const url = `/Relationships(BusinessPartner1Id='${companyId}',BusinessPartner2Id='${beneficiaryId}',RelationshipTypeId='ZBUBA6')`;
        await wsdmzClient.get(url, {
            headers: {
                'Accept': 'application/xml',
                'x-csrf-token': authHeaders.csrfToken, // <-- AÑADIDO
                'Cookie': authHeaders.cookie,          // <-- AÑADIDO
            }
        });
        return true;
    } catch (error) {
        if (error.response?.status === 404) return false;
        console.error("Error al verificar relación:", error.response?.data);
        throw new Error("Fallo al consultar relación en perfil de empresa.");
    }
}

/**
 * CAMBIO: Ahora acepta el token CSRF como parámetro en lugar de obtenerlo.
 */
async function addBeneficiaryToCompany(beneficiaryPayload, authHeaders) {
    try {
        const response = await wsdmzClient.post('/Relationships/', beneficiaryPayload, {
            headers: {
                'x-csrf-token': authHeaders.csrfToken,
                'Cookie': authHeaders.cookie,
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
     * CAMBIO: Orquesta el flujo obteniendo el token UNA VEZ y pasándolo a las demás funciones.
     */
    createBeneficiary: async (beneficiaryInfo) => {
        const companyId = process.env.BUSINESS_PARTNER_1_ID;
        if (!companyId) throw new Error("BUSINESS_PARTNER_1_ID no está configurado en .env");

        // 1. Obtiene el token y la cookie al inicio del flujo.
        const authHeaders = await getCsrfToken();

        // 2. Pasa los headers de autenticación a la función de búsqueda global.
        const beneficiaryId = await findGlobalBeneficiary(beneficiaryInfo.identityType, beneficiaryInfo.identityNumber, authHeaders);

        if (beneficiaryId) {
            // 3. Pasa los headers a la función de verificación de relación.
            const relationshipExists = await checkBeneficiaryRelationship(companyId, beneficiaryId, authHeaders);
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
            "ZBUBA6Data": { /* ... */ } // Payload sin cambios
        };
        if (beneficiaryId) {
            payload.BusinessPartner2Id = beneficiaryId;
            delete payload.BusinessPartner2;
        }

        // 4. Pasa los headers a la función de creación.
        return addBeneficiaryToCompany(payload, authHeaders);
    },

    /**
     * Se mantiene igual, ya que siempre obtenía el token de todas formas.
     */
    createPaymentOrder: async (paymentPayload) => {
        try {
            const authHeaders = await getCsrfToken();
            const response = await wsdmzClient.post('/Orders/', paymentPayload, {
                headers: {
                    'x-csrf-token': authHeaders.csrfToken,
                    'Cookie': authHeaders.cookie,
                    'Accept-Language': 'ES',
                    'Content-Type': 'application/json'
                }
            });
            return xmlParser.parse(response.data);
        } catch (error) {
            console.error("Error al crear orden de pago:", error.response?.data);
            throw new Error("Fallo al crear la orden de pago.");
        }
    }
};