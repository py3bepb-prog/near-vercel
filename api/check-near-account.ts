// /api/check-near-account.ts
import { NextApiRequest, NextApiResponse } from 'next';
import { connect } from 'near-api-js';

// --- ИЗМЕНЕННАЯ КОНФИГУРАЦИЯ ДЛЯ TESTNET ---
const NEAR_NETWORK_CONFIG = { 
    networkId: "testnet",
    nodeUrl: "https://rpc.testnet.near.org", 
    // Добавьте другие необходимые параметры, если они есть
};
// ---------------------------------------------

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    const { nearAccount } = req.body;
    if (!nearAccount) return res.status(400).json({ error: 'Missing nearAccount' });

    try {
        const near = await connect(NEAR_NETWORK_CONFIG);
        const account = await near.account(nearAccount);
        await account.state(); 
        
        return res.status(200).json({ exists: true });
        
    } catch (error: any) {
        if (error.type && error.type === 'AccountDoesNotExist') {
            return res.status(200).json({ exists: false, message: 'Account does not exist on the NEAR blockchain.' });
        }
        console.error('NEAR RPC Error:', error);
        return res.status(500).json({ error: 'Internal server error while checking account.' });
    }
}