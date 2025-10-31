// Carga las variables de entorno del archivo .env
require('dotenv').config();

const axios = require('axios');
const https = require('https');
const fs = require('fs');
const path = require('path');

// --- VALIDACIÓN DE VARIABLES DE ENTORNO ---
const requiredEnvVars = [
    'CSRF_FETCH_URL',
    'API_BASE_URL',
    'API_USERNAME',
    'API_PASSWORD',
    'PFX_FILENAME',
    'PFX_PASSPHRASE'
];
for (const varName of requiredEnvVars) {
    if (!process.env[varName]) {
        throw new Error(`Error de configuración: La variable de entorno '${varName}' no está definida en el archivo .env`);
    }
}

// --- CONFIGURACIÓN ---
const config = {
    csrfFetchUrl: process.env.CSRF_FETCH_URL,
    apiBaseUrl: process.env.API_BASE_URL,
    username: process.env.API_USERNAME,
    password: process.env.API_PASSWORD,
    pfxPath: path.resolve(__dirname, process.env.PFX_FILENAME),
    pfxPassphrase: process.env.PFX_PASSPHRASE
};

// --- PREPARACIÓN ---

const basicAuth = Buffer.from(`${config.username}:${config.password}`).toString('base64');

let httpsAgent;
try {
    httpsAgent = new https.Agent({
        pfx: fs.readFileSync(config.pfxPath),
        passphrase: config.pfxPassphrase,
    });
} catch (err) {
    console.error(`Error al leer el archivo PFX en la ruta: ${config.pfxPath}`);
    process.exit(1);
}

const apiClient = axios.create({
    httpsAgent: httpsAgent,
    headers: {
        'Authorization': `Basic ${basicAuth}`
    }
});


// --- LÓGICA DE LA PETICIÓN ---

async function realizarPeticion() {
    try {
        // --- PASO 1: Obtener el token CSRF y las cookies de sesión ---
        console.log(`1. Obteniendo token y cookies de sesión desde: ${config.csrfFetchUrl}`);

        const tokenResponse = await apiClient.get(config.csrfFetchUrl, {
            headers: {
                'X-CSRF-Token': 'Fetch'
            }
        });

        const csrfToken = tokenResponse.headers['x-csrf-token'];
        const cookies = tokenResponse.headers['set-cookie'];

        if (!cookies) {
            throw new Error('No se pudieron obtener las cookies de sesión. Revisa la URL y las credenciales.');
        }

        console.log(`   -> Token CSRF (para futuras peticiones POST): ${csrfToken}`);
        console.log(`   -> Cookies de sesión obtenidas con éxito.`);

        // --- PASO 2: Realizar la consulta del Business Partner (GET) ---
        // Define los parámetros para la búsqueda
        const identityType = 'DORN';
        const identityNr = '101070XXX';

        // Construye la URL completa para la transacción GET.
        // OData (el formato de tu API) requiere que los strings en los parámetros vayan entre comillas simples.
        const transactionUrl = `${config.apiBaseUrl}/FindBusinessPartnerByIdentity?IdentityTypeId='${identityType}'&IdentityNr='${identityNr}'`;

        console.log(`\n2. Realizando la consulta GET a: ${transactionUrl}`);

        // Realizamos la petición GET.
        const businessPartnerResponse = await apiClient.get(transactionUrl, {
            headers: {
                // Para GET, la cabecera más importante es la Cookie para mantener la sesión.
                'Cookie': cookies.join('; ')
                // 'X-CSRF-Token': csrfToken // <-- Generalmente no es necesario para GET, pero no daña si lo incluyes.
            }
        });

        console.log('\n¡Consulta exitosa!');
        console.log('Respuesta del servidor:');
        // El resultado de una consulta OData suele estar dentro de una propiedad 'd' o 'd.results'
        console.log(JSON.stringify(businessPartnerResponse.data, null, 2));

    } catch (error) {
        console.error('\n--- OCURRIÓ UN ERROR ---');
        if (error.response) {
            console.error('Status:', error.response.status);
            console.error('Data:', error.response.data);
        } else if (error.request) {
            console.error('No se recibió respuesta del servidor:', error.request);
        } else {
            console.error('Error de configuración:', error.message);
        }
    }
}

// Ejecutar la función principal
realizarPeticion();