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
        throw new Error("Error consultando beneficiario global.");
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
        throw new Error("Fallo al consultar relación en perfil de empresa.");
    }
}

/**
 * Parsea una respuesta de error XML de SAP y la convierte en un mensaje legible.
 */
function parseSapError(errorData) {
    if (!errorData) {
        return "La respuesta del servidor no tuvo contenido (posible timeout o cierre de conexión).";
    }

    try {
        // 1. Parsea el XML a un objeto JavaScript
        const parsedError = xmlParser.parse(errorData);

        // 2. Extrae el mensaje principal de forma segura
        const mainMessage = parsedError.error?.message?.value || "Error general al procesar la solicitud.";
        let detailedErrorMessage = `La API de ePagos devolvió los siguientes errores:\n- Mensaje Principal: ${mainMessage}\n`;

        // 3. Navega de forma segura hasta el array de detalles
        const errorDetailsArray = parsedError.error?.innererror?.errordetails?.errordetail;
        
        if (errorDetailsArray) {
            // 4. Normaliza a un array (si es un solo objeto, lo convierte en un array de 1 elemento)
            const details = Array.isArray(errorDetailsArray) ? errorDetailsArray : [errorDetailsArray];
            
            // 5. Itera y formatea cada detalle
            details.forEach((detail, index) => {
                if (detail && detail.message) { // Asegurarse de que el objeto de detalle es válido
                    detailedErrorMessage += `  - Detalle ${index + 1}: [${detail.severity || 'info'}] ${detail.message} (Código: ${detail.code || 'N/A'})\n`;
                }
            });
        }
        
        return detailedErrorMessage;

    } catch (parseError) {
        return `La respuesta del servidor no fue un XML de error válido. Contenido: ${errorData}`;
    }
}

/**
 * Función interna para crear la relación del beneficiario
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

        // --- Manejo detallado de la respuesta de ÉXITO ---
        const parsedData = xmlParser.parse(response.data);
        const properties = parsedData.entry?.content['m:properties'];
        return {
            success: true,
            message: "Beneficiario vinculado exitosamente.",
            details: {
                companyId: properties['d:BusinessPartner1Id'],
                beneficiaryId: properties['d:BusinessPartner2Id'],
                relationshipType: properties['d:RelationshipTypeId']
            }
        };

    } catch (error) {
        throw new Error(parseSapError(error.response?.data));
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
            throw new Error(parseSapError(error.response?.data));
        }
    },

    checkBeneficiaryRelationshipExists
};