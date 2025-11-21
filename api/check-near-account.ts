// /api/check-near-account.ts (ИСПРАВЛЕННЫЙ КОД ДЛЯ ДИАГНОСТИКИ)

import { NextApiRequest, NextApiResponse } from 'next';
import { connect } from 'near-api-js';

const NEAR_NETWORK_CONFIG = {
    networkId: "testnet",
    nodeUrl: "https://rpc.testnet.near.org",
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    const { nearAccount } = req.body || {}; // <-- Безопасное чтение

    if (!nearAccount || typeof nearAccount !== 'string' || nearAccount.length === 0) {
        return res.status(400).json({ error: 'Missing nearAccount.' });
    }

    try {
        const near = await connect(NEAR_NETWORK_CONFIG);
        const account = await near.account(nearAccount);
        
        // Попытка получить состояние аккаунта.
        await account.state(); 
        
        return res.status(200).json({ exists: true });
        
    } catch (error: any) {
        // Проверка на известную ошибку
        if (error.type && error.type === 'AccountDoesNotExist') {
            return res.status(200).json({ exists: false, message: 'Account does not exist on the NEAR blockchain.' });
        }
        
        // --- ДИАГНОСТИЧЕСКИЙ ВЫВОД ---
        console.error('NEAR RPC Error Details:', error);
        
        // ВРЕМЕННО возвращаем детали ошибки для отладки
        return res.status(500).json({ 
            error: 'Internal server error while checking account.',
            details: error.message || String(error), // Отправляем сообщение об ошибке
            errorType: error.type 
        });
    }
}