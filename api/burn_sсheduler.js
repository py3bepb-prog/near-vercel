const nearAPI = require('near-api-js');
const { send } = require('micro');
const { createClient } = require('@supabase/supabase-js');
const Big = require('big.js');

// --- MAINNET CONFIGURATION ---
const NETWORK_ID = 'mainnet';
const RPC_URL = 'https://rpc.mainnet.near.org';

const TOKEN_CONTRACT_ID = process.env.TOKEN_CONTRACT_ID;
const SENDER_ID = process.env.NEAR_SENDER_ID;
const PRIVATE_KEY = process.env.NEAR_PRIVATE_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL; 
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; 

const ONE_YOCTO = '1';
const GAS_LIMIT = '30000000000000'; // 30 TGas
const TOKEN_DECIMALS = 18; 

const provider = new nearAPI.providers.JsonRpcProvider({ url: RPC_URL });

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function toYoctoString(amount) {
    if (amount === undefined || amount === null) throw new Error("Amount is null");
    const amountBig = new Big(amount);
    return amountBig.toFixed(TOKEN_DECIMALS).replace('.', '');
}

module.exports = async (req, res) => {
    let batchId = null;
    let totalBurnAmount = 0; 
    
    if (!PRIVATE_KEY || !SENDER_ID || !TOKEN_CONTRACT_ID) {
        return send(res, 500, { error: 'Server configuration error.' });
    }

    try {
        // --- STEP 1: COLLECT PENDING BURNS ---
        const { data: collectData, error: collectError } = await supabase.rpc('collect_pending_burns');
        if (collectError) return send(res, 500, { error: 'DB collection failed.' });
        if (collectData.status === 'no_data') return send(res, 200, { message: 'No pending burns.', status: 'NO_OP' });
        
        batchId = collectData.batch_id;
        totalBurnAmount = parseFloat(collectData.total_amount);
        const transactionIds = collectData.transaction_ids; 
        
        console.log(`Starting Batch Burn ID ${batchId} for total amount: ${totalBurnAmount}`);
        const amountYoctoString = toYoctoString(totalBurnAmount);

        // --- STEP 2: NEAR MAINNET (Modern Approach) ---
        const keyStore = new nearAPI.keyStores.InMemoryKeyStore();
        await keyStore.setKey(NETWORK_ID, SENDER_ID, nearAPI.KeyPair.fromString(PRIVATE_KEY));
        
        const signer = new nearAPI.InMemorySigner(keyStore);
        const account = new nearAPI.Account({ provider, networkId: NETWORK_ID, signer, accountId: SENDER_ID });

        // Формируем действие сжигания (ft_burn)
        const burnAction = nearAPI.transactions.functionCall(
            'ft_burn',
            { amount: amountYoctoString, memo: `Batch Burn ID: ${batchId}` },
            GAS_LIMIT,
            ONE_YOCTO 
        );

        // Подписываем и отправляем
        const nearResult = await account.signAndSendTransaction({
            receiverId: TOKEN_CONTRACT_ID, 
            actions: [burnAction],
        });

        const transactionHash = nearResult.transaction.hash; 

        // --- STEP 3: COMPLETE IN DB ---
        const { error: completeError } = await supabase.rpc('burn_batch_complete', {
            p_batch_id: batchId,
            p_near_hash: transactionHash,
            p_status: 'completed',
        });

        if (completeError) {
            return send(res, 200, { 
                message: 'Burn successful, but DB update failed.', 
                hash: transactionHash,
                batch_ids: transactionIds
            });
        }
        
        return send(res, 200, {
            message: `Batch Burn completed. Amount: ${totalBurnAmount}.`,
            hash: transactionHash,
            batch_ids: transactionIds
        });

    } catch (e) {
        console.error('NEAR Burn Error:', e.message);
        if (batchId) {
            await supabase.rpc('burn_batch_complete', {
                p_batch_id: batchId, p_near_hash: null, p_status: 'failed', 
            });
        }
        return send(res, 500, { error: `Batch Burn failed: ${e.message}` });
    }
};