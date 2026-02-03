const nearAPI = require('near-api-js');
const { send } = require('micro');

// Используем Provider напрямую, чтобы избежать предупреждений о connect()
const RPC_URL = "https://rpc.mainnet.near.org";
const provider = new nearAPI.providers.JsonRpcProvider({ url: RPC_URL });

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return send(res, 405, { error: 'Method Not Allowed' });
    }

    let nearAccount;
    try {
        // Vercel может не распарсить body автоматически в некоторых конфигурациях micro
        // Если req.body пустой, пробуем распарсить вручную
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        nearAccount = body?.nearAccount;
    } catch (e) {
        return send(res, 400, { error: 'Invalid JSON body' });
    }

    if (!nearAccount) {
        return send(res, 400, { error: 'Missing nearAccount parameter.' });
    }

    try {
        // Заменяем устаревший .state() на запрос через провайдер
        // Это самый "чистый" способ проверить существование аккаунта без ворнингов
        await provider.query({
            request_type: "view_account",
            finality: "final",
            account_id: nearAccount,
        });
        
        return send(res, 200, { exists: true });
        
    } catch (error) {
        // Если аккаунта нет, NEAR RPC вернет ошибку, содержащую "does not exist"
        if (error.message && error.message.includes('does not exist')) {
            return send(res, 200, { exists: false, message: 'Account does not exist.' });
        }
        
        console.error('NEAR RPC Error:', error);
        return send(res, 500, { error: 'RPC Error', details: error.message });
    }
};