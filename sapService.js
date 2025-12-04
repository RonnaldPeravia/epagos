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
            const filter = "U_BPD_TrackID eq null"; 
            // Seleccionar solo campos necesarios para optimizar
            const select = "DocEntry,DocNum,CardCode,CardName,DocCurrency,TransferSum,TransferReference,Comments,U_BPD_Status";
            
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
    getBusinessPartner: async (cardCode) => {
        try {
            // Se asume que el proveedor tiene configurado el banco por defecto en la pestaña de condiciones de pago o bancos
            // Ojo: Se solicitan campos UDF de Sync y campos nativos de identificación
            const select = "CardCode,CardName,U_BPD_Synced,U_TipoIdentificacion,LicTradNum,BankCode,AccountNo";
            const response = await sapClient.get(`/BusinessPartners('${cardCode}')?$select=${select}`);
            return response.data;
        } catch (error) {
            console.error(`Error obteniendo BP ${cardCode}:`, error.response?.data);
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
            // updateData espera: { U_BPD_Status, U_BPD_TrackID, U_BPD_ErrDesc, U_BPD_SyncDate }
            await sapClient.patch(`/VendorPayments(${docEntry})`, updateData);
            console.log(`📝 Pago ${docEntry} actualizado en SAP.`);
        } catch (error) {
            console.error(`Error actualizando Pago ${docEntry}:`, error.response?.data);
        }
    }
};

module.exports = sapService;