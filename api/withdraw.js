// withdraw.js (MAINNET VERSION - CLEAN LOGS)
const nearAPI = require('near-api-js');
const { send } = require('micro');
const json = require('micro').json;
const { createClient } = require('@supabase/supabase-js');
const Big = require('big.js');

const NETWORK_ID = 'mainnet';
const RPC_URL = 'https://rpc.mainnet.near.org';

const TOKEN_CONTRACT_ID = process.env.TOKEN_CONTRACT_ID;
const SENDER_ID = process.env.NEAR_SENDER_ID;
const PRIVATE_KEY = process.env.NEAR_PRIVATE_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL; 
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; 

const ONE_YOCTO = '1';
const GAS_LIMIT = '30000000000000';
const MIN_STORAGE_DEPOSIT = '1250000000000000000000'; 
const MIN_WITHDRAWAL_AMOUNT = 10000.0; 
const TOKEN_DECIMALS = 18; 

// Инициализируем провайдер напрямую для избежания ворнингов connect()
const provider = new nearAPI.providers.JsonRpcProvider({ url: RPC_URL });

module.exports = async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { error: 'Method Not Allowed' });

    if (!PRIVATE_KEY || !SENDER_ID || !TOKEN_CONTRACT_ID) {
        return send(res, 500, { error: 'Server configuration error.' });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader) return send(res, 401, { error: 'Unauthorized' });
    const token = authHeader.replace('Bearer ', '');
    
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    let userId, transactionId = null, originalAmount = 0; 

    try {
        // --- AUTH & WALLET CHECK ---
        const { data: userData, error: authError } = await supabase.auth.getUser(token);
        if (authError || !userData?.user) return send(res, 401, { error: 'Invalid token' });
        userId = userData.user.id;
        
        const { data: walletData } = await supabase
            .from('wallets')
            .select('is_verified')
            .eq('user_id', userId)
            .eq('is_active', true)
            .single();

        if (!walletData?.is_verified) return send(res, 403, { error: 'Wallet not verified' });

        const data = await json(req);
        const { receiver_id, amount } = data;

        // --- MATH ---
        const amountBig = new Big(amount);
        originalAmount = parseFloat(amountBig.toFixed(8));
        const amountYoctoString = amountBig.toFixed(TOKEN_DECIMALS).replace('.', '');

        // --- DB LOCK ---
        const { data: dbResult, error: dbError } = await supabase.rpc('process_withdrawal_start', {
            p_user_id: userId, p_amount: originalAmount, p_receiver_id: receiver_id,
        });
        if (dbError || dbResult.status === 'error') return send(res, 400, { error: dbResult?.message || 'DB Error' });
        transactionId = dbResult.transaction_id;

        // --- NEAR TRANSACTION (Modern Way) ---
        const keyStore = new nearAPI.keyStores.InMemoryKeyStore();
        await keyStore.setKey(NETWORK_ID, SENDER_ID, nearAPI.KeyPair.fromString(PRIVATE_KEY));
        
        // Вместо connect() используем Account напрямую
        const signer = new nearAPI.InMemorySigner(keyStore);
        const account = new nearAPI.Account({ provider, networkId: NETWORK_ID, signer, accountId: SENDER_ID });

        const actions = [];
        
        // Используем современный способ вызова view-функций
        const storageRaw = await provider.query({
            request_type: "call_function",
            finality: "final",
            account_id: TOKEN_CONTRACT_ID,
            method_name: "storage_balance_of",
            args_base64: Buffer.from(JSON.stringify({ account_id: receiver_id })).toString('base64'),
        });
        const storageBalance = JSON.parse(Buffer.from(storageRaw.result).toString());

        if (!storageBalance) {
            actions.push(nearAPI.transactions.functionCall(
                'storage_deposit', { account_id: receiver_id, registration_only: true }, GAS_LIMIT, MIN_STORAGE_DEPOSIT
            ));
        }
        
        actions.push(nearAPI.transactions.functionCall(
            'ft_transfer', 
            { receiver_id, amount: amountYoctoString, memo: `VibeIndex Payout: ${userId.slice(0,8)}` }, 
            GAS_LIMIT, ONE_YOCTO
        ));

        const nearResult = await account.signAndSendTransaction({
            receiverId: TOKEN_CONTRACT_ID,
            actions: actions,
        });

        const transactionHash = nearResult.transaction.hash; 

        // --- DB COMPLETION ---
        await supabase.rpc('process_withdrawal_complete', {
            p_transaction_id: transactionId, p_hash: transactionHash,
        });
        
        return send(res, 200, { success: true, transaction_id: transactionHash });

    } catch (e) {
        console.error('Withdrawal Error:', e.message);
        if (transactionId) {
            await supabase.rpc('process_withdrawal_rollback', {
                p_transaction_id: transactionId, p_user_id: userId, p_amount: originalAmount,
            });
        }
        return send(res, 500, { error: e.message });
    }
};