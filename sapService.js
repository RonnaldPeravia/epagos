const axios = require('axios');
const https = require('https');
require('dotenv').config();

// Agente para ignorar errores de certificado auto-firmados en SAP (común en entornos on-premise)
const sapAgent = new https.Agent({
    rejectUnauthorized: false
});

const sapClient = axios.create({
    baseURL: process.env.SBO_SERVER_URL, // Ej: https://sap-server:50000/b1s/v1
    httpsAgent: sapAgent,
    withCredentials: true // Importante para cookies de sesión
});

let sessionCookie = null;

const sapService = {
    /**
     * Realiza Login en Service Layer
     */
    login: async () => {
        try {
            const response = await sapClient.post('/Login', {
                CompanyDB: process.env.SBO_COMPANY_DB,
                UserName: process.env.SBO_USER,
                Password: process.env.SBO_PASSWORD
            });

            // Guardar cookies de sesión (B1SESSION, ROUTEID)
            sessionCookie = response.headers['set-cookie'];
            sapClient.defaults.headers.Cookie = sessionCookie;
            console.log('✅ Login SAP Exitoso');
            return true;
        } catch (error) {
            console.error('❌ Error Login SAP:', error.response?.data || error.message);
            throw new Error('No se pudo conectar a SAP Service Layer');
        }
    },

    /**
     * Cierra la sesión para no saturar el servidor
     */
    logout: async () => {
        try {
            if (sessionCookie) {
                await sapClient.post('/Logout');
                sessionCookie = null;
                // console.log('🔒 Logout SAP realizado');
            }
        } catch (error) {
            // Ignorar error en logout
        }
    },

    /**
     * Obtiene pagos donde el TrackID es nulo
     */
    getPendingPayments: async () => {
        try {
            // Filtro: TrackID vacío Y Status vacío o nulo
            const filter = "DocNum eq 5669";
            // Seleccionar solo campos necesarios para optimizar
            const select = "DocEntry,DocNum,CardCode,CardName,DocCurrency,TransferSum,TransferReference, U_BPD_OrderNumber, U_BPD_status, U_BPD_message, U_BPD_success, U_BPD_details";

            const response = await sapClient.get(`/VendorPayments?$filter=${filter}&$select=${select}`);
            return response.data.value;
        } catch (error) {
            console.error('Error obteniendo pagos:', error.response?.data);
            throw error;
        }
    },

    /**
     * Obtiene datos extendidos del Socio de Negocio (Banco, Cuenta, Identificación, Status Sync)
     */
    /**
     * Obtiene datos del Socio de Negocio y su primera cuenta bancaria.
     */
    getBusinessPartner: async (cardCode) => {
        try {
            // --- 1. Obtener datos generales del BP (sin cambios) ---
            const bpSelect = "CardCode,CardName,U_BPD_Synced,FederalTaxID";
            const bpResponse = await sapClient.get(`/BusinessPartners('${cardCode}')?$select=${bpSelect}`);
            const businessPartnerData = bpResponse.data;

            // --- 2. Obtener la información de las cuentas bancarias (sin cambios en la llamada) ---
            const bankResponse = await sapClient.get(`/BusinessPartners('${cardCode}')/BPBankAccounts`);

            // --- CORRECCIÓN CRÍTICA: Leemos desde 'bankResponse.data.BPBankAccounts' ---
            const bankAccountsArray = bankResponse.data.BPBankAccounts;

            if (!bankAccountsArray || bankAccountsArray.length === 0) {
                throw new Error(`El proveedor ${cardCode} no tiene NINGUNA cuenta bancaria configurada en la pestaña 'Bancos' de SAP.`);
            }

            // Tomamos el primer elemento del array correcto
            const firstBankAccount = bankAccountsArray[0];

            console.log('firstBankAccount: ', firstBankAccount)

            // --- 3. Combinamos los resultados en un solo objeto (sin cambios) ---
            return {
                ...businessPartnerData,
                BankCode: firstBankAccount.BankCode,
                AccountNo: firstBankAccount.AccountNo,
                AccountTypeControlKey: firstBankAccount.ControlKey
            };

        } catch (error) {
            console.error(`Error obteniendo datos completos de BP ${cardCode}:`, error.response?.data || error.message);
            throw error;
        }
    },

    /**
     * Actualiza el Socio de Negocio (Marcar como sincronizado)
     */
    updateBPSyncStatus: async (cardCode, status) => {
        try {
            await sapClient.patch(`/BusinessPartners('${cardCode}')`, {
                U_BPD_Synced: status
            });
        } catch (error) {
            console.error(`Error actualizando BP ${cardCode}:`, error.message);
        }
    },

    /**
     * Actualiza el Pago con el resultado de la operación
     */
    updatePaymentStatus: async (docEntry, updateData) => {
        try {
            // updateData espera: { U_BPD_status, U_BPD_OrderNumber, U_BPD_message, U_BPD_SyncDate }
            await sapClient.patch(`/VendorPayments(${docEntry})`, updateData);
            console.log(`📝 Pago ${docEntry} actualizado en SAP.`);
        } catch (error) {
            console.error(`Error actualizando Pago ${docEntry}:`, error.response?.data);
        }
    }
};

module.exports = sapService;