// /api/verify-signature.ts
import { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';
import { connect } from 'near-api-js';
import { verify } from 'tweetnacl-ts'; 
import * as bs58 from 'bs58';
import { Buffer } from 'buffer';

// --- КОНФИГУРАЦИЯ ДЛЯ TESTNET ---
const NEAR_NETWORK_CONFIG = { 
    networkId: "testnet",
    nodeUrl: "https://rpc.testnet.near.org", 
};
// ---------------------------------------------

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    // ВАЖНО: Используйте Service Role Key для этого эндпоинта, так как он обновляет БД напрямую
    process.env.SUPABASE_SERVICE_ROLE_KEY! 
);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    const { nearAccount, verificationMessage, signature, userId } = req.body;

    if (!nearAccount || !verificationMessage || !signature || !userId) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // 1. ПРОВЕРКА СООБЩЕНИЯ В БД (ЗАЩИТА ОТ REPLAY)
    const { data: walletData, error: dbError } = await supabase
        .from('wallets')
        .select('verification_code, is_verified')
        .eq('near_account', nearAccount)
        .eq('user_id', userId)
        .single();
    
    if (dbError || !walletData || walletData.verification_code !== verificationMessage) {
        // Ошибка, если сообщение не совпадает или кошелек не привязан к этому пользователю
        return res.status(401).json({ success: false, error: 'Invalid message or wallet mismatch.' });
    }

    if (walletData.is_verified) {
        return res.status(200).json({ success: true, message: 'Wallet already verified.' });
    }

    // 2. КРИПТОГРАФИЧЕСКАЯ ПРОВЕРКА
    try {
        const near = await connect(NEAR_NETWORK_CONFIG);
        const account = await near.account(nearAccount);
        const state = await account.state();
        
        // Получаем Public Key
        const accessKey = state.authorizedAccessKeys.find(key => key.permission.type === 'FullAccess');
        if (!accessKey) {
            return res.status(400).json({ success: false, error: 'No active full access key found on NEAR blockchain.' });
        }
        
        const publicKeyBase58 = accessKey.publicKey.replace('ed25519:', ''); 
        
        // Декодирование
        const signatureBytes = Buffer.from(signature, 'base64');
        const publicKeyBytes = bs58.decode(publicKeyBase58);
        const messageBytes = Buffer.from(verificationMessage);
        
        // КРИПТОГРАФИЧЕСКАЯ ПРОВЕРКА
        const isSignatureValid = verify(messageBytes, signatureBytes, publicKeyBytes); 

        if (!isSignatureValid) {
            return res.status(401).json({ success: false, error: 'Signature is invalid.' });
        }
        
        // 3. ФИНАЛИЗАЦИЯ: Верификация успешна

        // Устанавливаем is_verified = TRUE
        await supabase
            .from('wallets')
            .update({ is_verified: true })
            .eq('near_account', nearAccount);
        
        // Вызываем SQL-функцию для клейма старых депозитов (user_id берется из токена внутри RPC)
        const { data: claimData, error: claimError } = await supabase.rpc('claim_unprocessed_deposits');

        if (claimError) {
             console.error('Claim RPC error (Note: Verification was successful):', claimError);
        }

        return res.status(200).json({ 
            success: true, 
            message: 'Verification successful. Deposits claimed.',
            claimed: claimData
        });

    } catch (error) {
        console.error('Verification failed (NEAR RPC or general error):', error);
        return res.status(500).json({ success: false, error: 'Internal server error during verification.' });
    }
}