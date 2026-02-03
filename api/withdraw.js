// withdraw.js (MAINNET VERSION - FIXED MATH)
const nearAPI = require('near-api-js');
const { send } = require('micro');
const json = require('micro').json;
const { createClient } = require('@supabase/supabase-js');
const Big = require('big.js');

const NETWORK_ID = 'mainnet';
const NODE_URL = 'https://rpc.mainnet.near.org';

const TOKEN_CONTRACT_ID = process.env.TOKEN_CONTRACT_ID;
const SENDER_ID = process.env.NEAR_SENDER_ID;
const PRIVATE_KEY = process.env.NEAR_PRIVATE_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL; 
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; 

const ONE_YOCTO = BigInt(1);
const GAS_LIMIT = BigInt('30000000000000');
const MIN_STORAGE_DEPOSIT = BigInt('1250000000000000000000'); 
const MIN_WITHDRAWAL_AMOUNT = 10000.0; 

const TOKEN_DECIMALS = 18; 

const nearConfig = {
    networkId: NETWORK_ID,
    nodeUrl: NODE_URL,
};

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return send(res, 405, { error: 'Method Not Allowed' });
    }

    if (!PRIVATE_KEY || !SENDER_ID || !TOKEN_CONTRACT_ID || !SUPABASE_SERVICE_ROLE_KEY) {
        return send(res, 500, { error: 'Server configuration error: Secrets missing.' });
    }
    
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return send(res, 401, { error: 'Authorization header missing or invalid.' });
    }
    const token = authHeader.replace('Bearer ', '');
    
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false }
    });

    let userId;
    let transactionId = null; 
    let originalAmount = 0; 

    try {
        const { data: userData, error: authError } = await supabase.auth.getUser(token);
        if (authError || !userData?.user) {
            return send(res, 401, { error: 'Invalid or expired authentication token.' });
        }
        userId = userData.user.id;
        
        const { data: walletData, error: walletError } = await supabase
            .from('wallets')
            .select('is_verified, is_active')
            .eq('user_id', userId)
            .eq('is_active', true)
            .single();

        if (walletError || !walletData || walletData.is_verified !== true) {
            return send(res, 403, { error: 'User wallet is not verified or not attached.' });
        }
    } catch (e) {
        return send(res, 500, { error: 'Internal authentication service error.' });
    }

    try {
        const data = await json(req);
        const { action, receiver_id, amount } = data;

        if (action !== 'transfer') {
             return send(res, 400, { error: `Action '${action}' not supported.` });
        }
        
        // --- FIXED MATH CONVERSION ---
        let amountYoctoString;
        try {
            const amountBig = new Big(amount);
            originalAmount = parseFloat(amountBig.toFixed(8)); 

            if (amountBig.lt(MIN_WITHDRAWAL_AMOUNT)) {
                 return send(res, 400, { error: `Minimum withdrawal amount is ${MIN_WITHDRAWAL_AMOUNT} VNDX.` });
            }
            
            // To prevent fractional math errors, we fix to DECIMALS and remove the dot
            // Example: 1.5 -> "1.500000000000000000" -> "1500000000000000000"
            amountYoctoString = amountBig.toFixed(TOKEN_DECIMALS).replace('.', '');
        } catch (e) {
            return send(res, 400, { error: 'Invalid amount format.' });
        }
        
        // --- STEP 1: DB LOCK ---
        const { data: dbResult, error: dbError } = await supabase.rpc('process_withdrawal_start', {
            p_user_id: userId,
            p_amount: originalAmount,
            p_receiver_id: receiver_id,
        });

        if (dbError || dbResult.status === 'error') {
             return send(res, 400, { error: dbError?.message || dbResult.message });
        }
        transactionId = dbResult.transaction_id;

        // --- STEP 2: NEAR MAINNET TRANSACTION ---
        const { KeyPair, keyStores, transactions } = nearAPI;
        const keyPair = KeyPair.fromString(PRIVATE_KEY);
        const keyStore = new keyStores.InMemoryKeyStore();
        await keyStore.setKey(NETWORK_ID, SENDER_ID, keyPair);
        
        const near = await nearAPI.connect({ ...nearConfig, keyStore });
        const account = await near.account(SENDER_ID);
        
        const actions = [];
        
        const storageBalance = await account.viewFunction({
            contractId: TOKEN_CONTRACT_ID,
            methodName: 'storage_balance_of',
            args: { account_id: receiver_id },
        });

        if (!storageBalance) {
            actions.push(
                transactions.functionCall(
                    'storage_deposit',
                    { account_id: receiver_id, registration_only: true },
                    GAS_LIMIT,
                    MIN_STORAGE_DEPOSIT
                )
            );
        }
        
        actions.push(
            transactions.functionCall(
                'ft_transfer',
                { 
                    receiver_id: receiver_id, 
                    amount: amountYoctoString, 
                    memo: `VibeIndex Payout: ${userId.slice(0,8)}` 
                },
                GAS_LIMIT,
                ONE_YOCTO
            )
        );

        const nearResult = await account.signAndSendTransaction({
            receiverId: TOKEN_CONTRACT_ID,
            actions: actions,
        });

        const transactionHash = nearResult.transaction.hash; 

        // --- STEP 3: DB COMPLETION ---
        const { error: completeError } = await supabase.rpc('process_withdrawal_complete', {
            p_transaction_id: transactionId,
            p_hash: transactionHash,
        });

        if (completeError) {
            return send(res, 200, { 
                success: true, 
                message: `Payout successful. Hash: ${transactionHash}. Warning: DB update failed.`,
                transaction_id: transactionHash 
            });
        }
        
        return send(res, 200, {
            success: true,
            message: 'Withdrawal successful',
            transaction_id: transactionHash,
        });

    } catch (e) {
        console.error('Withdrawal Error:', e.message);
        // --- STEP 4: DB ROLLBACK ---
        if (transactionId) {
            await supabase.rpc('process_withdrawal_rollback', {
                p_transaction_id: transactionId,
                p_user_id: userId,
                p_amount: originalAmount,
            });
        }
        return send(res, 500, { error: `Transaction failed: ${e.message}. Balance restored.` });
    }
};