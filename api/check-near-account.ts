// /api/check-near-account.ts (MAINNET ВЕРСИЯ)
import { NextApiRequest, NextApiResponse } from 'next';
import { connect, keyStores } from 'near-api-js';

// --- КОНФИГУРАЦИЯ ДЛЯ MAINNET ---
const NEAR_NETWORK_CONFIG = {
    networkId: "mainnet",
    // Используем основной RPC или быстрый прокси от FastNear для надежности
    nodeUrl: "https://rpc.mainnet.near.org", 
    keyStore: new keyStores.InMemoryKeyStore(), // Чтение не требует приватных ключей
};
// ---------------------------------

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    const { nearAccount } = req.body || {}; 

    if (!nearAccount || typeof nearAccount !== 'string' || nearAccount.trim().length === 0) {
        return res.status(400).json({ error: 'Missing nearAccount.' });
    }

    try {
        const near = await connect(NEAR_NETWORK_CONFIG);
        const account = await near.account(nearAccount);
        
        // Метод state() вернет данные, если аккаунт существует в Mainnet
        await account.state(); 
        
        return res.status(200).json({ exists: true });
        
    } catch (error: any) {
        // Обработка специфической ошибки NEAR "Аккаунт не найден"
        if (error.message && (error.message.includes('does not exist') || error.type === 'AccountDoesNotExist')) {
            return res.status(200).json({ exists: false, message: 'Account does not exist on NEAR Mainnet.' });
        }
        
        console.error('NEAR Mainnet RPC Error:', error);
        return res.status(500).json({ 
            error: 'RPC Error',
            details: error.message || String(error)
        });
    }
}