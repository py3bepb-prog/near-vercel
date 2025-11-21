// /api/check-near-account.ts (НАДЕЖНАЯ ВЕРСИЯ)
import { NextApiRequest, NextApiResponse } from 'next';
import { connect, keyStores } from 'near-api-js'; // <-- ИМПОРТ keyStores

// --- КОНФИГУРАЦИЯ ДЛЯ TESTNET ---
const NEAR_NETWORK_CONFIG = {
    networkId: "testnet",
    nodeUrl: "https://rpc.testnet.near.org",
    // 💡 КРИТИЧЕСКОЕ ДОБАВЛЕНИЕ: Пустое хранилище ключей для режима "только чтение"
    keyStore: new keyStores.InMemoryKeyStore(), // <-- Инициализация пустого хранилища
};
// ---------------------------------

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    const { nearAccount } = req.body || {}; 

    if (!nearAccount || typeof nearAccount !== 'string' || nearAccount.length === 0) {
        return res.status(400).json({ error: 'Missing nearAccount.' });
    }

    try {
        // 1. Инициализация с явным keyStore
        const near = await connect(NEAR_NETWORK_CONFIG);
        
        // 2. Получение аккаунта и проверка его состояния
        const account = await near.account(nearAccount);
        await account.state(); 
        
        return res.status(200).json({ exists: true });
        
    } catch (error: any) {
        // 3. Обработка ошибок
        if (error.type && error.type === 'AccountDoesNotExist') {
            return res.status(200).json({ exists: false, message: 'Account does not exist on the NEAR blockchain.' });
        }
        
        console.error('NEAR RPC Unexpected Error:', error);
        return res.status(500).json({ 
            error: 'Internal server error while checking account.',
            details: error.message || String(error)
        });
    }
}