const nearAPI = require('near-api-js');
const { send } = require('micro');

// --- CONFIGURATION ---
const NEAR_NETWORK_CONFIG = {
    networkId: "mainnet",
    nodeUrl: "https://rpc.mainnet.near.org", 
    keyStore: new nearAPI.keyStores.InMemoryKeyStore(),
};

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return send(res, 405, { error: 'Method Not Allowed' });
    }

    // В micro тело запроса нужно распарсить, если ты не используешь хелпер json
    // Но так как мы работаем в Vercel, можно использовать простой подход:
    let nearAccount;
    try {
        const body = req.body || {}; // Vercel автоматически парсит JSON в req.body
        nearAccount = body.nearAccount;
    } catch (e) {
        return send(res, 400, { error: 'Invalid JSON body' });
    }

    if (!nearAccount || typeof nearAccount !== 'string' || nearAccount.trim().length === 0) {
        return send(res, 400, { error: 'Missing nearAccount parameter.' });
    }

    try {
        const near = await nearAPI.connect(NEAR_NETWORK_CONFIG);
        const account = await near.account(nearAccount);
        
        // Check state to verify existence
        await account.state(); 
        
        return send(res, 200, { exists: true });
        
    } catch (error) {
        // Near-api-js throws if account doesn't exist
        if (error.message && (error.message.includes('does not exist') || error.type === 'AccountDoesNotExist')) {
            return send(res, 200, { exists: false, message: 'Account does not exist on NEAR Mainnet.' });
        }
        
        console.error('NEAR RPC Error:', error);
        return send(res, 500, { 
            error: 'RPC Error',
            details: error.message || String(error)
        });
    }
};