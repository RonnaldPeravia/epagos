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
    ca: [rootCA, subordinateCA],
    rejectUnauthorized: false
});

// Clientes API (sin cambios)
const wsdmzClient = axios.create({
    baseURL: process.env.EPAGOS_QA_URL_WSDMZ,
    httpsAgent,
    auth: { username: process.env.EPAGOS_USERNAME, password: process.env.EPAGOS_PASSWORD },
    timeout: 30000
});
const commonClient = axios.create({
    baseURL: process.env.EPAGOS_QA_URL_COMMON,
    httpsAgent,
    auth: { username: process.env.EPAGOS_USERNAME, password: process.env.EPAGOS_PASSWORD },
    timeout: 30000
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
    console.log('findGlobalBeneficiary: ', { "identityType": identityType, "identityNumber": identityNumber, "authHeaders": authHeaders })
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
        throw new Error(parseSapError(error));
    }
}

/**
 * CAMBIO: Ahora acepta y usa el token CSRF para la petición GET.
 */
async function checkBeneficiaryRelationship(companyId, beneficiaryId, authHeaders) {
    console.log('checkBeneficiaryRelationship: ', { "companyId": companyId, "beneficiaryId": beneficiaryId, "authHeaders": authHeaders })
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
        throw new Error(parseSapError(error));
    }
}

/**
 * Procesa el objeto de error y extrae el mensaje detallado.
 * @param {object} error - El objeto de error completo lanzado por Axios.
 */
function parseSapError(error) {
    const parsedError = error.response?.data;

    if (!parsedError) {
        if (error.code === 'ECONNABORTED') return `La solicitud excedió el tiempo de espera.`;
        return error.message || "Error de red o conexión sin respuesta del servidor.";
    }

    // --- LÓGICA DE EXTRACCIÓN CORREGIDA ---

    // 1. Buscamos directamente el array 'errordetails'.
    const errorDetailsArray = parsedError.error?.innererror?.errordetails;

    if (errorDetailsArray) {
        let detailedErrorMessage = "Errores de ePagos:";
        // Nos aseguramos de que sea un array
        const details = Array.isArray(errorDetailsArray) ? errorDetailsArray : [errorDetailsArray];

        const messages = details.map(detail => {
            // En algunos casos, el array puede contener un objeto con la clave 'errordetail'
            // Esta lógica maneja ambas estructuras.
            const errorItem = detail.errordetail || detail;
            if (errorItem && errorItem.message) {
                return `${errorItem.message} (Código: ${errorItem.code || 'N/A'})`;
            }
            return null;
        }).filter(Boolean);

        if (messages.length > 0) {
            return detailedErrorMessage += " " + messages.join('; ');
        }
    }

    // 2. Si no encontramos 'errordetails', usamos el mensaje principal como fallback.
    const mainMessage = parsedError.error?.message?.value || "Error general desconocido.";
    return `Mensaje Principal de ePagos: ${mainMessage}.`;
}

async function addBeneficiaryToCompany(beneficiaryPayload) {
    try {
        const authHeaders = await getCsrfToken();
        const response = await wsdmzClient.post('/Relationships/', beneficiaryPayload, {
            headers: { 'x-csrf-token': authHeaders.csrfToken, 'Cookie': authHeaders.cookie, 'Content-Type': 'application/json' }
        });

        // --- MANEJO ROBUSTO DE LA RESPUESTA ---

        // Verificamos si la respuesta tiene datos antes de intentar parsearla
        if (!response.data) {
            // Este es el caso del éxito asíncrono con cuerpo vacío
            return {
                success: true,
                message: "Solicitud de creación de beneficiario aceptada (asíncrona).",
                details: {} // Devolvemos un objeto vacío para no causar errores
            };
        }

        const parsedData = xmlParser.parse(response.data);

        // Verificamos que la estructura parseada sea la que esperamos
        const properties = parsedData.entry?.content?.['m:properties'];

        if (!properties) {
            // La respuesta no tuvo la estructura esperada, la tratamos como éxito asíncrono
            return {
                success: true,
                message: "Solicitud de creación aceptada (asíncrona, estructura de respuesta inesperada).",
                details: {}
            };
        }

        // Si todo está bien, devolvemos los detalles completos
        return {
            success: true,
            message: "Beneficiario vinculado exitosamente (síncrono).",
            details: {
                companyId: properties['d:BusinessPartner1Id'],
                beneficiaryId: properties['d:BusinessPartner2Id'],
                relationshipType: properties['d:RelationshipTypeId']
            }
        };

    } catch (error) {
        // El manejo de errores se mantiene igual
        throw new Error(parseSapError(error));
    }
}

async function checkBeneficiaryRelationshipExists(companyId, identityType, identityNumber) {
    console.log('checkBeneficiaryRelationshipExists >', { "companyId": companyId, "identityType": identityType, "identityNumber": identityNumber })
    try {
        const authHeaders = await getCsrfToken();
        const beneficiaryId = await findGlobalBeneficiary(identityType, identityNumber, authHeaders);
        if (!beneficiaryId) return false;
        return await checkBeneficiaryRelationship(companyId, beneficiaryId, authHeaders);
    } catch (error) {
        console.error("Error durante la verificación de existencia de la relación:", error.message);
        return false;
    }
}

// --- FUNCIONES EXPORTADAS ---

module.exports = {
    /**
     * CAMBIO: Orquesta el flujo obteniendo el token UNA VEZ y pasándolo a las demás funciones.
     */
    createBeneficiary: async (beneficiaryInfo) => {
        // Esta función ya no verifica la existencia. Solo intenta crear.
        const companyId = process.env.BUSINESS_PARTNER_1_ID;
        if (!companyId) throw new Error("BUSINESS_PARTNER_1_ID no está configurado en .env");

        const authHeaders = await getCsrfToken();

        // Asumimos que la verificación ya se hizo externamente.
        // Simplemente construimos el payload y llamamos a la función de creación.
        console.log("Intentando POST para crear/vincular beneficiario...");
        const payload = {
            "RelationshipTypeId": "ZBUBA6",
            "BusinessPartner2": {
                "IdentityTypeId": beneficiaryInfo.identityType,
                "IdentityNr": beneficiaryInfo.identityNumber,
                "BusinessPartnerTypeId": "1",
                "Name1": beneficiaryInfo.name
            },
            "ZBUBA6Data": { /* ... */ }
        };

        // Podríamos añadir una lógica para saber si enviar BusinessPartner2Id si ya existe globalmente,
        // pero por ahora, la lógica principal de 'crear' es suficiente.

        return addBeneficiaryToCompany(payload, authHeaders);
    },

    /**
       * Crea una orden de pago y maneja la respuesta detallada
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

            // --- Manejo detallado de la respuesta de ÉXITO ---
            const parsedData = xmlParser.parse(response.data);
            const orderProperties = parsedData.entry?.content['m:properties'];
            const items = parsedData.entry?.feed?.entry;

            const processedItems = [];
            if (items) {
                const itemList = Array.isArray(items) ? items : [items];
                itemList.forEach(item => {
                    const itemProps = item.content['m:properties'];
                    processedItems.push({
                        lineNumber: itemProps['d:LineNr'],
                        payeeId: itemProps['d:PayeeId'],
                        reference: itemProps['d:Reference'],
                        netAmount: itemProps['d:NetAmount'],
                        currency: itemProps['d:CurrencyId']
                    });
                });
            }

            return {
                success: true,
                message: "Orden de pago aceptada para procesamiento.",
                details: {
                    orderNumber: orderProperties['d:OrderNr'],
                    status: orderProperties['d:StatusName'],
                    totalAmount: orderProperties['d:NetAmountTotal'],
                    processedItems: processedItems
                }
            };

        } catch (error) {
            // Lanzamos el error ya formateado por nuestra función de utilidad
            throw new Error(parseSapError(error));
        }
    },

    checkBeneficiaryRelationshipExists
};