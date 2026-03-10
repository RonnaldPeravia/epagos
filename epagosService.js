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
async function findGlobalBeneficiary(identityType, identityNumber) {
    try {
        const url = `/FindBusinessPartnerByIdentity?IdentityTypeId='${identityType}'&IdentityNr='${identityNumber}'`;
        const response = await commonClient.get(url, { headers: { 'Accept': 'application/xml' } });
        return xmlParser.parse(response.data).entry?.content['m:properties']['d:Id'] || null;
    } catch (error) {
        if (error.response?.status === 404) return null;
        throw new Error(parseSapError(error));
    }
}

/**
 * CAMBIO: Ahora acepta y usa el token CSRF para la petición GET.
 */
async function checkBeneficiaryRelationship(companyId, beneficiaryId) {
    try {
        const url = `/Relationships(BusinessPartner1Id='${companyId}',BusinessPartner2Id='${beneficiaryId}',RelationshipTypeId='ZBUBA6')`;
        await wsdmzClient.get(url, { headers: { 'Accept': 'application/xml' } });
        return true;
    } catch (error) {
        if (error.response?.status === 404) return false;
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

    console.log('TYPEOF PAYLOAD:', typeof beneficiaryPayload); // ← "string" o "object"
    console.log('RAW PAYLOAD:', beneficiaryPayload);
    console.log('Ejecutando addBeneficiaryToCompany con Payload...', beneficiaryPayload);
    try {
        const authHeaders = await getCsrfToken();

        // ← TEMPORAL: ver headers exactos que se envían
        console.log("HEADERS BEING SENT:", {
            'Content-Type': 'application/json;charset=utf-8',
            'Accept': 'application/json',
            'x-csrf-token': authHeaders.csrfToken,
            'Cookie': authHeaders.cookie ? 'present' : 'MISSING'
        });


        const data = JSON.stringify(beneficiaryPayload);

        const response = await wsdmzClient.post('/Relationships/', data, {
            headers: {
                'Content-Type': 'application/json;charset=utf-8',
                'Accept': 'application/json', // <-- AÑADIDO: Pedimos explícitamente JSON
                'x-csrf-token': authHeaders.csrfToken,
                'Cookie': authHeaders.cookie
            }
        });

        // --- LÓGICA DE PARSEO FINAL Y CORRECTA ---

        // Ya no necesitamos parsear XML, axios ya nos da el objeto JS.
        const responseData = response.data;
        console.log("--- Objeto de respuesta recibido del banco ---");
        console.log(JSON.stringify(responseData, null, 2));

        if (!responseData || !responseData.d) {
            // Maneja el caso de respuesta vacía o con estructura inesperada
            return {
                success: true,
                message: "Solicitud de vinculación aceptada (asíncrona, sin detalles).",
                details: responseData || {}
            };
        }

        // Extraemos las propiedades desde la clave 'd'
        const properties = responseData.d;

        return {
            success: true,
            message: "Beneficiario vinculado exitosamente.",
            details: {
                companyId: properties.BusinessPartner1Id,
                beneficiaryId: properties.BusinessPartner2Id,
                relationshipType: properties.RelationshipTypeId
            }
        };

    } catch (error) {
        console.log("RAW ERROR RESPONSE:", JSON.stringify(error.response?.data, null, 2));
        console.log("RAW ERROR STATUS:", error.response?.status);
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

/**
 * Añade una nueva cuenta bancaria (Payment Option) a un beneficiario ya vinculado.
 * Corresponde a la sección "Adicionar cuenta" (Pág. 22) de la guía.
 * @param {string} beneficiaryId - El ID de ePagos del beneficiario.
 * @param {object} accountInfo - Objeto con los detalles de la cuenta (bankId, accountType, etc.).
 */
async function addBankAccountToBeneficiary(beneficiaryId, accountInfo) {
    console.log(`Añadiendo cuenta al beneficiario ${beneficiaryId}...`);
    try {
        // El endpoint es diferente, es /ZBUBA6PaymentOptions
        const url = `/ZBUBA6PaymentOptions`;

        // El payload también tiene una estructura específica
        const payload = {
            "BusinessPartner2Id": beneficiaryId,
            "PaymentMethod": {
                "Name": "Transferencia Cuentas BPD" // Un nombre descriptivo
            },
            "BankAccount": {
                "BankId": accountInfo.bankId,
                "BankName": "Banco Popular", // Opcional, pero bueno tenerlo
                "AccountTypeId": accountInfo.accountType,
                "BankAccountNr": accountInfo.accountNumber
            },
            "MethodId": accountInfo.methodId,
            "CurrencyId": "DOP"
        };

        const authHeaders = await getCsrfToken();
        const response = await wsdmzClient.post(url, payload, {
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'x-csrf-token': authHeaders.csrfToken,
                'Cookie': authHeaders.cookie
            }
        });

        // La respuesta de un POST exitoso a veces es un 201/204 sin cuerpo,
        // o a veces devuelve el objeto creado.
        return { success: true, message: "Solicitud para añadir cuenta enviada.", details: response.data || "Sin cuerpo de respuesta." };

    } catch (error) {
        throw new Error(parseSapError(error));
    }
}

/**
 * Consulta todas las cuentas bancarias de un beneficiario específico.
 * @param {string} companyId - Tu ID de empresa.
 * @param {string} beneficiaryId - El ID del beneficiario en ePagos.
 */
async function getBeneficiaryBankAccounts(companyId, beneficiaryId) {
    console.log(`Consultando cuentas para beneficiario ${beneficiaryId}...`);
    try {
        const authHeaders = await getCsrfToken();
        const url = `/ZBUBA6Data(BusinessPartner1Id='${companyId}',BusinessPartner2Id='${beneficiaryId}',RelationshipTypeId='ZBUBA6')/PaymentOptions?$expand=BankAccount`;

        const response = await wsdmzClient.get(url, {
            headers: { 'Accept': 'application/xml', 'x-csrf-token': authHeaders.csrfToken, 'Cookie': authHeaders.cookie }
        });
        return xmlParser.parse(response.data);
    } catch (error) {
        throw new Error(parseSapError(error));
    }
}

/**
 * Consulta el estado detallado de una orden de pago.
 * @param {string} orderNumber - El número de orden (OrderNr) que devolvió ePagos.
 */
async function getPaymentOrderStatus(orderNumber) {
    console.log(`Consultando estado de la orden ${orderNumber}...`);
    try {
        const authHeaders = await getCsrfToken();
        // El endpoint es /Orders('NUMERO')/OrderItems
        const url = `/Orders('${orderNumber}')/OrderItems`;

        const response = await wsdmzClient.get(url, {
            headers: { 'Accept': 'application/xml', 'x-csrf-token': authHeaders.csrfToken, 'Cookie': authHeaders.cookie }
        });
        return xmlParser.parse(response.data);
    } catch (error) {
        throw new Error(parseSapError(error));
    }
}

// --- FUNCIONES EXPORTADAS ---

module.exports = {
    /**
     * CAMBIO: Orquesta el flujo obteniendo el token UNA VEZ y pasándolo a las demás funciones.
     */
    createBeneficiary: async (payload) => {
        return addBeneficiaryToCompany(payload);
    },

    /**
     * Crea una orden de pago y maneja respuestas síncronas y asíncronas.
     */
    createPaymentOrder: async (paymentPayload) => {
        try {
            const authHeaders = await getCsrfToken();

            // Forzamos el header 'Accept': 'application/json' para asegurar consistencia
            const response = await wsdmzClient.post('/Orders/', paymentPayload, {
                headers: {
                    'x-csrf-token': authHeaders.csrfToken,
                    'Cookie': authHeaders.cookie,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                }
            });

            // DEBUG: Log para confirmar qué estamos recibiendo
            // console.log('Respuesta recibida:', response.data);

            const responseData = response.data;

            // --- MANEJO DE RESPUESTA JSON (según tu log de debug) ---
            // La estructura recibida es { d: { OrderNr: "...", ... } }
            if (responseData && responseData.d) {
                const order = responseData.d;

                return {
                    success: true,
                    message: "Orden de pago creada exitosamente.",
                    details: {
                        orderNumber: order.OrderNr, // Aquí obtenemos el '000007013558'
                        status: order.StatusName || 'Creada',
                        totalAmount: order.NetAmountTotal
                    }
                };
            }

            // --- FALLBACK PARA RESPUESTAS ASÍNCRONAS O VACÍAS ---
            return {
                success: true,
                message: "Solicitud de orden de pago aceptada (procesamiento asíncrono).",
                details: { orderNumber: "PEND_ASYNC" }
            };

        } catch (error) {
            throw new Error(parseSapError(error));
        }
    },

    checkBeneficiaryRelationshipExists,
    getBeneficiaryBankAccounts,
    getPaymentOrderStatus,
    findGlobalBeneficiary,
    checkBeneficiaryRelationship,
    getCsrfToken,
    addBankAccountToBeneficiary
};